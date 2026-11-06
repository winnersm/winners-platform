"""Registro de llamadas a Meta para el reporte diario de «Llamadas a Meta».

Mismo formato de Redis que `apps/web/src/lib/meta-calls.ts`; si cambia allí, hay
que cambiarlo aquí. Cada servicio Python se construye por separado, así que este
archivo existe tanto en cloner-engine como en automations-worker.

Cuenta intentos reales (un reintento es otra llamada; un batch cuenta como una).
Registrar nunca rompe ni retrasa la llamada: solo deja el dato en una cola en
memoria y un hilo aparte lo escribe; si Redis falla, el dato se pierde. Nunca se
guarda la URL (lleva el token) ni un valor enviado: solo el tipo de llamada, los
nombres de los campos y unos pocos parámetros inocuos.

Además del total del día hay un detalle llamada a llamada, en una lista de Redis
por hora, con tope y caducidad. El texto que explica cada llamada se calcula al
leerla, en `apps/web/src/lib/meta-calls-explain.ts`.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple
from urllib.parse import parse_qsl, urlsplit

log = logging.getLogger(__name__)

# Bogotá no tiene horario de verano; así no hace falta instalar tzdata.
TZ_BOGOTA = timezone(timedelta(hours=-5))
RETENCION_SEG = 90 * 24 * 60 * 60
RETENCION_DETALLE_SEG = 7 * 24 * 60 * 60
MAX_DETALLE_POR_HORA = 20000
SEP = "\u0001"
CODIGOS_LIMITE = {4, 17, 32, 613}
SERVICIO = "cloner-engine"
MAX_COLA = 5000
MAX_LOTE = 200
CLAVES_CONSULTA = ("fields", "level", "date_preset", "time_range", "time_increment", "limit", "breakdowns", "type")
MAX_VALOR = 200
MAX_CAMPOS = 20
MAX_SUBLLAMADAS = 5
CAMPO_VALIDO = re.compile(r"^[\w\[\]]{1,40}$")
# Quién llama de verdad: estos archivos solo hacen de intermediarios.
INTERMEDIARIOS = ("meta_calls.py", "fbapi.py")

_cola: "queue.Queue[Tuple[str, str, str, str]]" = queue.Queue(maxsize=MAX_COLA)
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


def codigo_de(payload: Any) -> Optional[int]:
    """Código de error de Meta en la respuesta, si lo hay."""
    error = payload.get("error") if isinstance(payload, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    return code if isinstance(code, int) else None


def _quien_llama() -> str:
    """Archivo y función que hicieron la llamada: es la «ruta» de este servicio."""
    marco = sys._getframe(1)
    while marco is not None:
        archivo = os.path.basename(marco.f_code.co_filename)
        if archivo not in INTERMEDIARIOS:
            return "{} · {} · {}()".format(SERVICIO, archivo, marco.f_code.co_name)
        marco = marco.f_back
    return SERVICIO


def _describir_cuerpo(cuerpo: Any) -> Dict[str, Any]:
    """De lo enviado solo interesan los nombres, el estado y qué lleva un batch."""
    if isinstance(cuerpo, bytes):
        cuerpo = cuerpo.decode("utf-8", "ignore")
    datos = dict(parse_qsl(cuerpo)) if isinstance(cuerpo, str) else cuerpo
    if not isinstance(datos, Mapping):
        return {}
    out: Dict[str, Any] = {}
    campos = [
        k for k in datos
        if k not in ("access_token", "batch") and isinstance(k, str) and CAMPO_VALIDO.match(k)
    ][:MAX_CAMPOS]
    if campos:
        out["body"] = campos
    if isinstance(datos.get("status"), str):
        out["status"] = datos["status"][:40]
    try:
        lote = datos.get("batch")
        lista = json.loads(lote) if isinstance(lote, str) else lote
        if isinstance(lista, list):
            # relative_url puede llevar un token: solo se guarda lo anterior al «?».
            urls = [str(b.get("relative_url") or "") for b in lista]
            out["batch"] = {
                "n": len(lista),
                "items": [
                    "{} {}".format(b.get("method") or "GET", u.split("?")[0])
                    for b, u in list(zip(lista, urls))[:MAX_SUBLLAMADAS]
                ],
            }
            campos_lote = dict(parse_qsl(urlsplit(urls[0]).query)).get("fields") if urls else None
            if campos_lote:
                out["batch"]["fields"] = campos_lote[:MAX_VALOR]
    except Exception:
        pass  # un batch ilegible se queda sin desglose
    return out


def detalle_llamada(
    origen: str, method: str, url: str, resultado: str, ruta: str, inicio: float,
    params: Optional[Mapping[str, Any]] = None, cuerpo: Any = None,
    http: Optional[int] = None, codigo: Optional[int] = None,
) -> Dict[str, Any]:
    """Una llamada tal como queda en el detalle; mismo formato que MetaCallEntry."""
    u = urlsplit(url)
    consulta: Dict[str, Any] = dict(parse_qsl(u.query))
    consulta.update(params or {})
    endpoint, cuenta = describir_llamada(url, method, params)
    d: Dict[str, Any] = {
        "t": int(inicio * 1000),
        "ms": max(int((time.time() - inicio) * 1000), 0),
        "src": origen,
        "ep": endpoint,
        "path": "/".join([p for p in u.path.split("/") if p][1:]),
        "res": resultado,
        "route": ruta,
    }
    if cuenta:
        d["acct"] = cuenta
    if isinstance(http, int):
        d["http"] = http
    if codigo:
        d["code"] = codigo
    if "after" in consulta:
        d["paged"] = True
    q = {k: str(consulta[k])[:MAX_VALOR] for k in CLAVES_CONSULTA if consulta.get(k) not in (None, "")}
    if q:
        d["q"] = q
    d.update(_describir_cuerpo(cuerpo))
    return d


def registrar_llamada(
    origen: str, method: str, url: str, resultado: str,
    params: Optional[Mapping[str, Any]] = None, cuerpo: Any = None,
    inicio: Optional[float] = None, http: Optional[int] = None,
    codigo: Optional[int] = None,
) -> None:
    """Anota una llamada sin esperar a Redis. Nunca lanza."""
    try:
        inicio = time.time() if inicio is None else inicio
        endpoint, cuenta = describir_llamada(url, method, params)
        ruta = _quien_llama()
        momento = datetime.fromtimestamp(inicio, TZ_BOGOTA)
        campo = SEP.join((origen, endpoint, cuenta, resultado, ruta))
        detalle = json.dumps(
            detalle_llamada(origen, method, url, resultado, ruta, inicio, params, cuerpo, http, codigo),
            ensure_ascii=False, separators=(",", ":"),
        )
        _cola.put_nowait((momento.strftime("%Y-%m-%d"), str(momento.hour), campo, detalle))
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


def _escribir(cliente: Any, lote: List[Tuple[str, str, str, str]]) -> None:
    pipe = cliente.pipeline(transaction=False)
    dias = set()
    for dia, hora, campo, detalle in lote:
        dias.add(dia)
        registro = "meta:calls:{}:log:{}".format(dia, hora)
        pipe.rpush(registro, detalle)
        pipe.ltrim(registro, -MAX_DETALLE_POR_HORA, -1)
        pipe.expire(registro, RETENCION_DETALLE_SEG)
        pipe.hincrby("meta:calls:{}".format(dia), campo, 1)
        pipe.hincrby("meta:calls:{}:hours".format(dia), hora, 1)
        pipe.hincrby("meta:calls:{}:hours".format(dia), "total", 1)
    for dia in dias:
        pipe.expire("meta:calls:{}".format(dia), RETENCION_SEG)
        pipe.expire("meta:calls:{}:hours".format(dia), RETENCION_SEG)
    pipe.execute()
