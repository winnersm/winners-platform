"""Registro de llamadas a Meta para el reporte diario de «Llamadas a Meta».

Mismo formato de Redis que `apps/web/src/lib/meta-calls.ts`; si cambia allí, hay
que cambiarlo aquí. Cada servicio Python se construye por separado, así que este
archivo existe tanto en cloner-engine como en automations-worker.

Cuenta intentos reales (un reintento es otra llamada; un batch cuenta como una).
Registrar nunca rompe ni retrasa la llamada: solo deja el dato en una cola en
memoria y un hilo aparte lo escribe; si Redis falla, el dato se pierde. Solo se
guarda el tipo de llamada, nunca la URL: lleva el token.
"""

from __future__ import annotations

import logging
import os
import queue
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional, Tuple
from urllib.parse import parse_qsl, urlsplit

log = logging.getLogger(__name__)

# Bogotá no tiene horario de verano; así no hace falta instalar tzdata.
TZ_BOGOTA = timezone(timedelta(hours=-5))
RETENCION_SEG = 90 * 24 * 60 * 60
SEP = "\u0001"
CODIGOS_LIMITE = {4, 17, 32, 613}
MAX_COLA = 5000
MAX_LOTE = 200

_cola: "queue.Queue[Tuple[str, str, str]]" = queue.Queue(maxsize=MAX_COLA)
_candado = threading.Lock()
_hilo: Optional[threading.Thread] = None


def describir_llamada(
    url: str, method: str = "GET", params: Optional[Mapping[str, Any]] = None
) -> Tuple[str, str]:
    """Tipo de llamada y cuenta a partir de la URL, sin ningún dato sensible."""
    u = urlsplit(url)
    consulta = dict(parse_qsl(u.query))
    consulta.update(params or {})
    partes = [p for p in u.path.split("/") if p][1:]  # sin la versión (/v21.0)
    cuenta = partes[0][4:] if partes and partes[0].startswith("act_") else ""
    resto = [p for p in (partes[1:] if cuenta else partes) if not p.isdigit()]
    nombre = "/".join(resto) or ("cuenta" if cuenta else "objeto" if partes else "batch")
    if nombre == "insights":
        periodo = consulta.get("date_preset") or ("rango" if "time_range" in consulta else "")
        nombre = " ".join(str(x) for x in ("insights", consulta.get("level"), periodo) if x)
    return "{} {}".format(method.upper(), nombre), cuenta


def resultado_de(ok: bool, payload: Any = None) -> str:
    """ok, limit o error, a partir del estado HTTP y del cuerpo de la respuesta."""
    con_error = isinstance(payload, dict) and "error" in payload
    if ok and not con_error:
        return "ok"
    error = payload.get("error") if con_error else None
    code = error.get("code") if isinstance(error, dict) else None
    if isinstance(code, int) and (code in CODIGOS_LIMITE or 80000 <= code <= 80014):
        return "limit"
    return "error"


def registrar_llamada(
    origen: str, method: str, url: str, resultado: str,
    params: Optional[Mapping[str, Any]] = None,
) -> None:
    """Anota una llamada sin esperar a Redis. Nunca lanza."""
    try:
        endpoint, cuenta = describir_llamada(url, method, params)
        ahora = datetime.now(TZ_BOGOTA)
        campo = SEP.join((origen, endpoint, cuenta, resultado))
        _cola.put_nowait((ahora.strftime("%Y-%m-%d"), str(ahora.hour), campo))
        _arrancar_hilo()
    except Exception:
        pass  # incluye la cola llena: el registro nunca debe afectar a la llamada


def _arrancar_hilo() -> None:
    global _hilo
    if _hilo is not None:
        return
    with _candado:
        if _hilo is None:
            _hilo = threading.Thread(target=_enviador, daemon=True, name="meta-calls")
            _hilo.start()


def _enviador() -> None:
    url = os.environ.get("REDIS_URL")
    if not url:
        log.warning("Sin REDIS_URL: las llamadas a Meta no llegan al reporte")
        return
    try:
        import redis

        cliente = redis.Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1)
    except Exception as e:
        log.warning("Reporte de llamadas a Meta sin Redis: %s", type(e).__name__)
        return

    while True:
        lote = [_cola.get()]
        while len(lote) < MAX_LOTE:
            try:
                lote.append(_cola.get_nowait())
            except queue.Empty:
                break
        try:
            _escribir(cliente, lote)
        except Exception as e:
            log.warning("No se registraron %d llamadas a Meta: %s", len(lote), type(e).__name__)


def _escribir(cliente: Any, lote: list) -> None:
    pipe = cliente.pipeline(transaction=False)
    dias = set()
    for dia, hora, campo in lote:
        dias.add(dia)
        pipe.hincrby("meta:calls:{}".format(dia), campo, 1)
        pipe.hincrby("meta:calls:{}:hours".format(dia), hora, 1)
        pipe.hincrby("meta:calls:{}:hours".format(dia), "total", 1)
    for dia in dias:
        pipe.expire("meta:calls:{}".format(dia), RETENCION_SEG)
        pipe.expire("meta:calls:{}:hours".format(dia), RETENCION_SEG)
    pipe.execute()
