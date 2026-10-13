"""
Almacenamiento en Postgres. Sustituye a config.yaml, state.json e
incidents.jsonl.

Además de unificar los datos, resuelve un fallo concreto: config.yaml se monta
como fichero suelto en el contenedor, y sobre un bind-mount de fichero no
funciona el patrón de guardar-en-temporal-y-renombrar. El panel tenía que
escribirlo directamente, sin red: un corte a media escritura dejaba la
configuración a medias.

El estado y el histórico se conservan en las mismas tablas que lee el panel,
así que lo que se ve en pantalla es siempre el último ciclo.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import psycopg2
import psycopg2.extras

from .models import LinkConfig

log = logging.getLogger(__name__)


def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def load_links() -> tuple[list[LinkConfig], dict[str, str]]:
    """Los links a vigilar y las sustituciones de macros, desde la base."""
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, name, url, "expectedUrl", "expectRedirect", "expectedText",
                       "maxResponseMs"
                FROM monitor."MonitoredLink"
                WHERE enabled
                ORDER BY name
                """
            )
            filas = cur.fetchall()

            cur.execute(
                """SELECT key, value FROM core."Setting"
                    WHERE key IN ('monitor.defaults', 'monitor.macro_replacements')"""
            )
            ajustes = {r["key"]: r["value"] for r in cur.fetchall()}
    finally:
        conn.close()

    import json

    defaults: dict[str, Any] = json.loads(ajustes.get("monitor.defaults") or "{}")
    macros: dict[str, str] = json.loads(ajustes.get("monitor.macro_replacements") or "{}")

    links = [
        LinkConfig(
            name=f["name"],
            url=f["url"],
            expected_final=f["expectedUrl"],
            expected_redirect=f["expectRedirect"],
            expected_text=f["expectedText"] or None,
            max_response_ms=f["maxResponseMs"],
            timeout_ms=defaults.get("timeout_ms", 15000),
            max_redirects=defaults.get("max_redirects", 10),
            user_agent=defaults.get("user_agent", ""),
        )
        for f in filas
    ]

    # El id se guarda aparte: LinkConfig es el contrato del checker y no debe
    # cargar con detalles de persistencia.
    global _ids_por_nombre
    _ids_por_nombre = {f["name"]: f["id"] for f in filas}

    return links, macros


_ids_por_nombre: dict[str, str] = {}


def link_id(nombre: str) -> str | None:
    return _ids_por_nombre.get(nombre)


def load_state() -> dict:
    """Estado actual de cada link, en el mismo formato que usaba state.json."""
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT name, status, "lastOkAt", "lastFailAt", "lastCheckAt"
                FROM monitor."MonitoredLink"
                """
            )
            filas = cur.fetchall()
    finally:
        conn.close()

    estado = {}
    for f in filas:
        if f["status"] == "UNKNOWN":
            continue
        # `since`: desde cuándo está en su estado actual.
        desde = f["lastFailAt"] if f["status"] == "FAIL" else f["lastOkAt"]
        estado[f["name"]] = {
            "status": f["status"],
            "since": desde.isoformat() if desde else "",
        }
    return estado


def save_check(result, transition: str | None, since: str | None) -> None:
    """
    Guarda el resultado de una comprobación.

    Cada ciclo deja una fila en MonitorCheck: es lo que permite calcular el
    uptime, que con solo el estado actual era imposible.
    """
    lid = link_id(result.name)
    if not lid:
        log.warning("%s: no está en la base, no se guarda su resultado", result.name)
        return

    estado = "OK" if result.ok else "FAIL"
    motivo = result.failures[0] if getattr(result, "failures", None) else None

    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO monitor."MonitorCheck"
                  ("linkId", "checkedAt", status, "httpStatus", "finalUrl",
                   "responseMs", "failReason", detail)
                VALUES (%s, %s, %s::monitor."LinkHealth", %s, %s, %s, %s, %s)
                """,
                (
                    lid, result.checked_at, estado, result.status_final,
                    result.final_url, result.response_ms, motivo,
                    "; ".join(result.failures) if getattr(result, "failures", None) else None,
                ),
            )

            # Estado del link. consecutiveFails se acumula o se reinicia aquí,
            # para no tener que recorrer el histórico cada vez.
            if result.ok:
                cur.execute(
                    """
                    UPDATE monitor."MonitoredLink"
                       SET status = 'OK', "lastCheckAt" = %s, "lastOkAt" = %s,
                           "consecutiveFails" = 0, "updatedAt" = now()
                     WHERE id = %s
                    """,
                    (result.checked_at, result.checked_at, lid),
                )
            else:
                cur.execute(
                    """
                    UPDATE monitor."MonitoredLink"
                       SET status = 'FAIL', "lastCheckAt" = %s, "lastFailAt" = %s,
                           "consecutiveFails" = "consecutiveFails" + 1, "updatedAt" = now()
                     WHERE id = %s
                    """,
                    (result.checked_at, result.checked_at, lid),
                )

            # Los incidentes registran solo las TRANSICIONES, no cada ciclo:
            # es lo que evita convertir una caída larga en cientos de avisos.
            if transition == "to_fail":
                cur.execute(
                    """
                    INSERT INTO monitor."MonitorIncident"
                      (id, "linkId", "openedAt", reason, detail, notified)
                    VALUES (gen_random_uuid()::text, %s, %s, %s, %s, true)
                    """,
                    (lid, result.checked_at, (motivo or "")[:200],
                     "; ".join(result.failures) if getattr(result, "failures", None) else None),
                )
            elif transition == "to_ok":
                cur.execute(
                    """
                    UPDATE monitor."MonitorIncident"
                       SET "closedAt" = %s
                     WHERE "linkId" = %s AND "closedAt" IS NULL
                    """,
                    (result.checked_at, lid),
                )
        conn.commit()
    finally:
        conn.close()


def take_check_requests() -> list[str]:
    """
    Comprobaciones pedidas desde el panel.

    Se marcan como atendidas en la MISMA consulta que las devuelve: hacerlo en
    dos pasos permitiría que un reinicio entre medias las repitiera.
    """
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE monitor."MonitoredLink"
                   SET "checkRequestedAt" = NULL
                 WHERE id IN (
                       SELECT id FROM monitor."MonitoredLink"
                        WHERE "checkRequestedAt" IS NOT NULL AND enabled
                        FOR UPDATE SKIP LOCKED
                 )
                RETURNING name
                """
            )
            nombres = [r[0] for r in cur.fetchall()]
        conn.commit()
        return nombres
    finally:
        conn.close()
