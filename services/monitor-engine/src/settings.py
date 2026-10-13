"""Ajustes globales del monitor, en core.Setting.

Antes vivían en data/settings.json, compartido por fichero entre el panel y el
motor. Ahora los escribe el panel en la base y el motor los lee de ahí, que es
donde ya está el resto de su configuración.
"""

import logging
import os

import psycopg2

log = logging.getLogger(__name__)

CLAVE_INTERVALO = "monitor.interval_minutes"

MIN_SECONDS = 15        # piso de seguridad: por debajo se martillea el tracker / gasta recursos
MAX_SECONDS = 86400     # 24h


def _env_default_seconds() -> int:
    """Fallback inicial: el CHECK_INTERVAL_MIN del .env (o 30 min) hasta que el panel guarde."""
    try:
        minutes = int(os.environ.get("CHECK_INTERVAL_MIN", "30"))
    except ValueError:
        minutes = 30
    return max(MIN_SECONDS, minutes * 60)


def get_interval_seconds() -> int:
    """Intervalo entre ciclos. Si la base no responde, se usa el del entorno."""
    try:
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT value FROM core."Setting" WHERE key = %s', (CLAVE_INTERVALO,)
                )
                row = cur.fetchone()
        finally:
            conn.close()
    except Exception as e:
        log.error("No se pudo leer el intervalo (%s), se usa el del entorno", e)
        return _env_default_seconds()

    if row and row[0]:
        try:
            return max(MIN_SECONDS, min(MAX_SECONDS, int(row[0]) * 60))
        except ValueError:
            log.error("Intervalo inválido en la base: %r", row[0])

    return _env_default_seconds()


def fmt_interval(seconds: int) -> str:
    """Segundos → texto humano: '30 seg', '5 min', '1 h'."""
    if seconds < 60:
        return f"{seconds} seg"
    if seconds < 3600:
        m = seconds / 60
        return f"{int(m)} min" if m.is_integer() else f"{m:.1f} min"
    h = seconds / 3600
    return f"{int(h)} h" if h.is_integer() else f"{h:.1f} h"
