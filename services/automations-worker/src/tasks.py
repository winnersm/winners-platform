"""
Configuración de las tareas, leída de la base.

Hasta ahora los horarios estaban escritos a mano en main.py y el on/off por
tarea no se consultaba: el panel enseñaba unos valores y el worker usaba otros.
Aquí la base pasa a ser la única fuente de verdad, y lo que se ve en la
pantalla es lo que de verdad ocurre.

También vive aquí el filtro de cuentas. Es lo que permite dejar una cuenta
fuera de la pausa automática o de la limpieza de anuncios, que hasta ahora
actuaban sobre todas las que veía el token, sin excepción posible.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any

import psycopg2
import psycopg2.extras

log = logging.getLogger(__name__)


def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


@dataclass
class Task:
    name: str
    display_name: str
    cron: str
    timezone: str
    enabled: bool
    scope_mode: str          # ALL | INCLUDE | EXCLUDE
    scope_accounts: list[str]
    params: dict[str, Any] = field(default_factory=dict)
    dry_run: bool = False

    def applies_to(self, account_id: str) -> bool:
        """¿Esta tarea debe tocar esta cuenta?"""
        if self.scope_mode == "ALL":
            return True
        # El id de Meta va unas veces con prefijo "act_" y otras sin él.
        normalized = account_id.removeprefix("act_")
        selected = {a.removeprefix("act_") for a in self.scope_accounts}
        if self.scope_mode == "INCLUDE":
            return normalized in selected
        if self.scope_mode == "EXCLUDE":
            return normalized not in selected
        return True

    def filter_accounts(self, accounts: dict[str, str]) -> dict[str, str]:
        """Deja solo las cuentas sobre las que esta tarea puede actuar."""
        if self.scope_mode == "ALL":
            return accounts
        kept = {k: v for k, v in accounts.items() if self.applies_to(k)}
        log.info(
            "%s: %d de %d cuentas tras aplicar el alcance (%s)",
            self.name, len(kept), len(accounts), self.scope_mode,
        )
        return kept


def load_tasks() -> dict[str, Task]:
    """Todas las tareas configuradas, activas o no."""
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT name, "displayName", cron, timezone, enabled,
                       "scopeMode", "scopeAccounts", params, "dryRun"
                FROM automations.automation_tasks
                """
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    return {
        r["name"]: Task(
            name=r["name"],
            display_name=r["displayName"],
            cron=r["cron"],
            timezone=r["timezone"],
            enabled=r["enabled"],
            scope_mode=r["scopeMode"],
            scope_accounts=list(r["scopeAccounts"] or []),
            params=dict(r["params"] or {}),
            dry_run=bool(r["dryRun"]),
        )
        for r in rows
    }


def load_task(name: str) -> Task | None:
    return load_tasks().get(name)


def automations_enabled() -> bool:
    """Interruptor general. Si no se puede leer, quien llama decide qué hacer."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT value FROM automations.system_flags WHERE key = 'automations_enabled'"
            )
            row = cur.fetchone()
            return True if row is None else bool(row[0])
    finally:
        conn.close()


def mark_last_run(name: str) -> None:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'UPDATE automations.automation_tasks SET "lastRunAt" = now() WHERE name = %s',
                (name,),
            )
        conn.commit()
    finally:
        conn.close()


def take_pending_triggers() -> list[str]:
    """
    Ejecuciones manuales pedidas desde el panel.

    Se marcan como procesadas en la MISMA consulta que las devuelve: si se
    hicieran en dos pasos, un reinicio entre medias las ejecutaría dos veces.
    """
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE automations.task_triggers
                   SET processed = true, "processedAt" = now()
                 WHERE id IN (
                       SELECT id FROM automations.task_triggers
                        WHERE NOT processed
                        ORDER BY "requestedAt"
                        FOR UPDATE SKIP LOCKED
                 )
                RETURNING "taskName"
                """
            )
            names = [r[0] for r in cur.fetchall()]
        conn.commit()
        return names
    finally:
        conn.close()


def save_run(
    task_name: str,
    started_at,
    finished_at,
    success: bool,
    result: dict | None = None,
    error_msg: str | None = None,
    triggered_by: str = "scheduler",
    dry_run: bool = False,
) -> None:
    import json

    duration = (finished_at - started_at).total_seconds()
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO automations.task_runs
                    ("taskName", "startedAt", "finishedAt", success, "errorMsg",
                     result, "durationS", "triggeredBy", "dryRun")
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    task_name, started_at, finished_at, success, error_msg,
                    json.dumps(result) if result else None,
                    duration, triggered_by, dry_run,
                ),
            )
        conn.commit()
    finally:
        conn.close()
