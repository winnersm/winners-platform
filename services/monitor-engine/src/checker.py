"""Motor de chequeo de las 4 dimensiones de salud de un link.

Diseño de concurrencia (importante):
- Dimensiones 1, 2 y 4 usan `requests` → son thread-safe y se corren en paralelo
  (ThreadPool) desde main.run_cycle().
- Dimensión 3 usa Playwright sync. La API sync de Playwright NO es thread-safe:
  un browser/página creado en un hilo no puede usarse desde otro. Por eso la
  dimensión 3 se ejecuta de forma secuencial en el hilo principal, reutilizando
  UN solo browser por ciclo (ver `render_and_check_text` + main.run_cycle).
"""

import re
from time import monotonic
from datetime import datetime, timezone

import requests

from .models import LinkConfig, CheckResult


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def apply_macros(url: str, replacements: dict) -> str:
    """Reemplaza los placeholders {{...}} de Facebook por valores dummy."""
    for macro, value in replacements.items():
        url = url.replace(macro, value)
    return url


def match_final(url: str, pattern: str) -> bool:
    """¿La URL final matchea el patrón esperado? (host + path, case-insensitive).

    Si `pattern` empieza con 're:' → regex search sobre la URL completa.
    Si no → substring case-insensitive sobre la URL completa.
    """
    if pattern.startswith("re:"):
        return re.search(pattern[3:], url, flags=re.IGNORECASE) is not None
    return pattern.lower() in url.lower()


def check_link(cfg: LinkConfig, macros: dict) -> CheckResult:
    """Ejecuta dimensiones 1, 2 y 4 (requests). La dimensión 3 (texto en lander)
    la aplica main.run_cycle() después, en el hilo principal, con el browser
    compartido. Devuelve un CheckResult; `final_url` queda en None si hubo fallo
    fatal de red (en cuyo caso no se intenta render)."""
    url = apply_macros(cfg.url, macros)
    failures: list[str] = []
    status_final: int | None = None
    final_url: str | None = None
    chain: list[str] = []
    elapsed_ms = 0

    t0 = monotonic()
    try:
        resp = requests.get(
            url,
            allow_redirects=True,
            timeout=cfg.timeout_ms / 1000,
            headers={"User-Agent": cfg.user_agent},
        )
        elapsed_ms = int((monotonic() - t0) * 1000)
        chain = [r.url for r in resp.history] + [resp.url]
        status_final = resp.status_code
        final_url = resp.url

        # --- Dim 1: status ---
        if resp.status_code != 200:
            failures.append(f"Status final {resp.status_code} (esperado 200)")
        for h in resp.history:
            if h.status_code >= 400:
                failures.append(f"Salto con error {h.status_code}: {h.url}")

        # redirect esperado
        if cfg.expected_redirect and len(resp.history) == 0:
            failures.append("No hubo redirección (se esperaba al menos 1 salto)")

        # --- Dim 2: destino final ---
        if cfg.expected_final:
            if not match_final(resp.url, cfg.expected_final):
                failures.append(
                    f"Destino final inesperado: {resp.url} "
                    f"(esperaba contener '{cfg.expected_final}')"
                )

        # --- Dim 4: tiempo ---
        if elapsed_ms > cfg.max_response_ms:
            failures.append(f"Lento: {elapsed_ms}ms (umbral {cfg.max_response_ms}ms)")

    except requests.exceptions.Timeout:
        elapsed_ms = int((monotonic() - t0) * 1000)
        failures.append(f"Timeout (>{cfg.timeout_ms}ms)")
    except requests.exceptions.RequestException as e:
        elapsed_ms = int((monotonic() - t0) * 1000)
        failures.append(f"Error de red: {e}")

    return CheckResult(
        name=cfg.name,
        ok=(len(failures) == 0),
        status_final=status_final,
        final_url=final_url,
        redirect_chain=chain,
        response_ms=elapsed_ms,
        failures=failures,
        checked_at=utcnow_iso(),
    )


def render_and_check_text(
    browser,
    url: str,
    expected_text: str,
    cfg: LinkConfig,
    nav_timeout_ms: int = 20000,
    settle_budget_ms: int = 10000,
) -> tuple[bool, str | None]:
    """Dim 3: renderiza el lander con Playwright headless y busca el substring.

    Diseñado para NO dar falsas alarmas en landers de afiliados:
    - Espera a `domcontentloaded` (fiable), NO a `networkidle` — los landers
      disparan píxeles/trackers sin parar y la red nunca queda en silencio, lo
      que hacía expirar el timeout aunque la página estuviera perfecta.
    - El texto puede pintarse por JS *después* del DOM, así que se SONDEA con
      reintentos cortos hasta `settle_budget_ms` antes de declarar fallo.
    - Reintenta la navegación una vez si el primer `goto` fue un hipo transitorio.

    Reutiliza el `browser` ya lanzado (uno por ciclo). Busca en el HTML y en el
    texto visible, case-insensitive. Devuelve (encontrado, nota_error_opcional).
    """
    needle = expected_text.lower()
    page = None

    def _has_text() -> bool:
        try:
            html = (page.content() or "").lower()
        except Exception:
            html = ""
        try:
            body_text = (page.inner_text("body") or "").lower()
        except Exception:
            body_text = ""
        return needle in html or needle in body_text

    try:
        page = browser.new_page(user_agent=cfg.user_agent or None)
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=nav_timeout_ms)
        except Exception:
            # Un reintento tolerante: 'commit' resuelve apenas arranca la navegación.
            page.goto(url, wait_until="commit", timeout=nav_timeout_ms)

        # Sondeo: chequeo inmediato y luego cada 1.5s hasta agotar el presupuesto.
        if _has_text():
            return True, None
        steps = max(1, settle_budget_ms // 1500)
        for _ in range(steps):
            try:
                page.wait_for_timeout(1500)
            except Exception:
                break
            if _has_text():
                return True, None

        # Tras darle tiempo de sobra, el texto realmente no apareció ⇒ fallo real.
        return False, "texto no presente tras render (la página cargó, pero sin el texto)"
    except Exception as e:
        return False, str(e)
    finally:
        if page is not None:
            try:
                page.close()
            except Exception:
                pass
