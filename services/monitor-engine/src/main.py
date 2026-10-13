"""Entrypoint del link-monitor.

- Carga config.yaml (defaults, macros, links).
- Cada 30 min (APScheduler) corre run_cycle():
    1) dims 1/2/4 en paralelo (ThreadPool, requests).
    2) dim 3 (texto en lander) secuencial en hilo principal con UN browser/ciclo.
    3) detecta transiciones OK/FAIL y notifica a Slack solo si cambió el estado.
    4) persiste state.json.
- Corre un ciclo inmediato al arranque (no espera 30 min).
"""

import logging
import os
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from logging.handlers import RotatingFileHandler

import yaml
from apscheduler.schedulers.background import BackgroundScheduler
from playwright.sync_api import sync_playwright

import json

from .models import LinkConfig
from .checker import check_link, render_and_check_text
from . import state as state_mod
from . import store
from . import notifier
from . import history
from . import settings as settings_mod

LAST_CYCLE_PATH = os.environ.get("LAST_CYCLE_PATH", "data/last_cycle.json")

CONFIG_PATH = os.environ.get("CONFIG_PATH", "config.yaml")
LOG_PATH = os.environ.get("LOG_PATH", "logs/monitor.log")
CHECK_INTERVAL_MIN = int(os.environ.get("CHECK_INTERVAL_MIN", "30"))
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "5"))

logger = logging.getLogger("link-monitor")


def setup_logging() -> None:
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(fmt)
    logger.addHandler(stream)

    os.makedirs(os.path.dirname(LOG_PATH) or ".", exist_ok=True)
    file_handler = RotatingFileHandler(LOG_PATH, maxBytes=5 * 1024 * 1024, backupCount=3)
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    # Silenciar el ruido de apscheduler/urllib3.
    logging.getLogger("apscheduler").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def load_config(path: str) -> tuple[list[LinkConfig], dict]:
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    defaults = raw.get("defaults", {}) or {}
    macros = raw.get("macro_replacements", {}) or {}
    links_raw = raw.get("links", []) or []

    links: list[LinkConfig] = []
    for item in links_raw:
        links.append(
            LinkConfig(
                name=item["name"],
                url=item["url"],
                expected_final=item.get("expected_final"),
                expected_redirect=item.get("expected_redirect", True),
                expected_text=item.get("expected_text") or None,
                max_response_ms=item.get("max_response_ms", defaults.get("max_response_ms", 8000)),
                timeout_ms=item.get("timeout_ms", defaults.get("timeout_ms", 15000)),
                max_redirects=item.get("max_redirects", defaults.get("max_redirects", 10)),
                user_agent=item.get("user_agent", defaults.get("user_agent", "")),
            )
        )
    return links, macros


def run_cycle(links: list[LinkConfig], macros: dict) -> None:
    if not links:
        logger.warning("No hay links configurados.")
        return

    # --- Fase requests (dims 1/2/4) en paralelo ---
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        results = list(pool.map(lambda cfg: check_link(cfg, macros), links))

    cfg_by_name = {c.name: c for c in links}

    # --- Fase Playwright (dim 3) secuencial, UN browser por ciclo ---
    needs_render = [
        r for r in results
        if cfg_by_name[r.name].expected_text and r.final_url
    ]
    if needs_render:
        logger.info("Playwright: abriendo navegador (Chromium) para %d link(s) con texto clave...",
                    len(needs_render))
        rendered_ok = 0
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
            try:
                for r in needs_render:
                    cfg = cfg_by_name[r.name]
                    found, err = render_and_check_text(
                        browser, r.final_url, cfg.expected_text, cfg
                    )
                    if found:
                        rendered_ok += 1
                        logger.info("  ✓ render OK: '%s' — texto '%s' encontrado en %s",
                                    r.name, cfg.expected_text, r.final_url)
                    else:
                        note = f"Texto '{cfg.expected_text}' NO encontrado en el lander"
                        if err:
                            note += f" (render error: {err})"
                        r.failures.append(note)
                        r.ok = False
                        logger.warning("  ✗ render FALLÓ: '%s' — %s", r.name, note)
            finally:
                browser.close()
        logger.info("Playwright: navegador cerrado. %d/%d landers renderizados con texto OK.",
                    rendered_ok, len(needs_render))
    else:
        logger.info("Ningún link requiere render Playwright este ciclo.")

    # --- Transiciones + notificaciones + persistencia ---
    state = store.load_state()
    n_ok = 0
    for r in results:
        prev = state.get(r.name, {})
        prev_status = prev.get("status")
        transition = state_mod.detect_transition(prev_status, r)

        if r.ok:
            n_ok += 1

        # Detalle en vivo que consume el panel web.
        live = {
            "last_final_url": r.final_url,
            "last_response_ms": r.response_ms,
            "last_status_final": r.status_final,
            "last_checked": r.checked_at,
            "last_chain": r.redirect_chain,
        }

        if transition == "to_fail":
            logger.warning("OK→FAIL: %s — %s", r.name, "; ".join(r.failures))
            notifier.notify_fail(r)
            history.append_incident(r.name, "FAIL", "; ".join(r.failures), r.checked_at, r.final_url)
            state[r.name] = {"status": "FAIL", "since": r.checked_at, "last_failures": r.failures, **live}
            store.save_check(r, "to_fail", None)
        elif transition == "to_ok":
            since = prev.get("since", "(desconocido)")
            logger.info("FAIL→OK (recovery): %s", r.name)
            notifier.notify_recovery(r, since)
            history.append_incident(r.name, "RECOVERY", f"Recuperado (estuvo caído desde {since})", r.checked_at, r.final_url)
            state[r.name] = {"status": "OK", "since": r.checked_at, "last_failures": [], **live}
            store.save_check(r, "to_ok", since)
        else:
            # Sin transición: actualizar detalle pero conservar 'since'.
            new_status = "OK" if r.ok else "FAIL"
            state[r.name] = {
                "status": new_status,
                "since": prev.get("since", r.checked_at),
                "last_failures": [] if r.ok else r.failures,
                **live,
            }
            store.save_check(r, None, None)

    state_mod.save_state(state)
    n_fail = len(results) - n_ok
    logger.info("Ciclo OK: %d/%d links sanos, %d FAIL", n_ok, len(results), n_fail)

    # Resumen del último ciclo para el panel (frescura del monitor).
    try:
        os.makedirs(os.path.dirname(LAST_CYCLE_PATH) or ".", exist_ok=True)
        with open(LAST_CYCLE_PATH, "w", encoding="utf-8") as f:
            json.dump({
                "checked_at": results[0].checked_at if results else "",
                "total": len(results),
                "ok": n_ok,
                "fail": n_fail,
            }, f, ensure_ascii=False, indent=2)
        os.chmod(LAST_CYCLE_PATH, 0o644)
    except OSError:
        logger.exception("No se pudo escribir last_cycle.json")


def main() -> None:
    setup_logging()

    if not notifier.SLACK_WEBHOOK_URL:
        logger.warning("SLACK_WEBHOOK_URL no configurado — modo SOLO-LOG (sin alertas a Slack).")

    links0, _ = store.load_links()
    logger.info("Cargados %d links activos desde la base. Intervalo: %d min.",
                len(links0), CHECK_INTERVAL_MIN)

    def atender_peticiones():
        """Comprueba los links para los que se ha pedido revisión desde el panel."""
        try:
            pedidos = store.take_check_requests()
        except Exception:
            logger.exception("No se pudieron leer las comprobaciones pedidas")
            return
        if not pedidos:
            return
        logger.info("Comprobación pedida desde el panel: %s", ", ".join(pedidos))
        try:
            links, macros = store.load_links()
            solicitados = [l for l in links if l.name in pedidos]
            if solicitados:
                run_cycle(solicitados, macros)
        except Exception:
            logger.exception("Falló la comprobación pedida desde el panel")

    def cycle():
        # Se relee en cada ciclo: lo que se cambia en el panel se aplica solo.
        try:
            links, macros = store.load_links()
        except Exception:
            logger.exception("No se pudo leer %s; se omite el ciclo.", CONFIG_PATH)
            return
        try:
            run_cycle(links, macros)
        except Exception:
            logger.exception("Error inesperado en run_cycle (el scheduler sigue vivo).")

    # Ciclo inmediato al arranque.
    cycle()

    # Intervalo GLOBAL desde el panel (data/settings.json); fallback al .env.
    current_interval = {"sec": settings_mod.get_interval_seconds()}

    scheduler = BackgroundScheduler(timezone=os.environ.get("TZ", "UTC"))
    scheduler.add_job(cycle, trigger="interval", seconds=current_interval["sec"],
                      id="check_cycle", max_instances=1, coalesce=True)

    def watch_settings():
        # Cada 30s: si el intervalo cambió desde el panel, reprogramar el ciclo en vivo.
        try:
            new_sec = settings_mod.get_interval_seconds()
            if new_sec != current_interval["sec"]:
                scheduler.reschedule_job("check_cycle", trigger="interval", seconds=new_sec)
                logger.info("Intervalo actualizado desde el panel: %s → %s",
                            settings_mod.fmt_interval(current_interval["sec"]),
                            settings_mod.fmt_interval(new_sec))
                current_interval["sec"] = new_sec
        except Exception:
            logger.exception("Error en watch_settings (no afecta el ciclo).")

    scheduler.add_job(watch_settings, trigger="interval", seconds=30, id="watch_settings")

    # Comprobaciones pedidas desde el panel: se atienden en menos de un minuto,
    # sin esperar al ciclo normal.
    scheduler.add_job(atender_peticiones, trigger="interval", seconds=45,
                      id="check_requests", max_instances=1, coalesce=True)
    scheduler.start()
    logger.info("Scheduler iniciado. Intervalo: %s (configurable desde el panel).",
                settings_mod.fmt_interval(current_interval["sec"]))

    stop = {"flag": False}

    def handle_signal(signum, frame):
        logger.info("Señal %s recibida — apagando.", signum)
        stop["flag"] = True

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    try:
        while not stop["flag"]:
            time.sleep(1)
    finally:
        scheduler.shutdown(wait=False)
        logger.info("link-monitor detenido.")


if __name__ == "__main__":
    main()
