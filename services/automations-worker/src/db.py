import psycopg2
import psycopg2.extras
import os
import json
from datetime import datetime, timezone


def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def save_job_run(job_name: str, started_at: datetime, finished_at: datetime,
                 success: bool, result: dict = None, error_msg: str = None,
                 triggered_by: str = "scheduler"):
    duration = (finished_at - started_at).total_seconds()
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO automations.task_runs
                   ("taskName", "startedAt", "finishedAt", success, "errorMsg", result, "durationS", "triggeredBy")
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (job_name, started_at, finished_at, success,
                 error_msg, json.dumps(result) if result else None, duration, triggered_by)
            )
        conn.commit()
    finally:
        conn.close()


def get_config_value(key: str, default: str = None):
    """Lee un ajuste de core.Setting. `default` si no existe o está vacío.

    Solo para valores NO secretos (cursores, marcas internas). Los secretos
    van cifrados en core.Secret y se leen con config.load_config().
    """
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT value FROM core."Setting" WHERE key = %s', (key,))
            row = cur.fetchone()
        if row and row[0] not in (None, ""):
            return row[0]
        return default
    finally:
        conn.close()


def set_config_value(key: str, value: str, label: str = None, section: str = "internal"):
    """Guarda un ajuste en core.Setting. Estado interno, nunca secretos."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                '''INSERT INTO core."Setting" (key, value, label, section, "updatedAt")
                   VALUES (%s, %s, %s, %s, now())
                   ON CONFLICT (key) DO UPDATE
                   SET value = EXCLUDED.value, "updatedAt" = now()''',
                (key, value, label, section)
            )
        conn.commit()
    finally:
        conn.close()


def save_account_snapshots(snapshots: list, checked_at: datetime):
    """snapshots: lista de dicts con account_id, account_name, status_code,
       status_label, level, balance, currency, error_msg."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            for s in snapshots:
                cur.execute(
                    """INSERT INTO automations.account_snapshots
                       ("checkedAt", "accountId", "accountName", "statusCode",
                        "statusLabel", level, balance, currency, "errorMsg")
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (checked_at, s["account_id"], s.get("account_name"),
                     s.get("status_code"), s.get("status_label"),
                     s.get("level"), s.get("balance"), s.get("currency"),
                     s.get("error_msg"))
                )
        conn.commit()
    finally:
        conn.close()


def get_latest_account_snapshots() -> dict:
    """Devuelve el snapshot más reciente por cuenta. Clave: account_id."""
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT DISTINCT ON ("accountId")
                    "accountId"   AS account_id,
                    "accountName" AS account_name,
                    "statusCode"  AS status_code,
                    "statusLabel" AS status_label,
                    level, balance, currency,
                    "errorMsg"    AS error_msg,
                    "checkedAt"   AS checked_at
                FROM automations.account_snapshots
                ORDER BY "accountId", "checkedAt" DESC
            """)
            return {row["account_id"]: dict(row) for row in cur.fetchall()}
    finally:
        conn.close()


def save_billing_alert(account_id: str, account_name: str,
                       alert_type: str, message: str, alerted_at: datetime):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO automations.billing_alerts
                   ("alertedAt", "accountId", "accountName", "alertType", message)
                   VALUES (%s, %s, %s, %s, %s)""",
                (alerted_at, account_id, account_name, alert_type, message)
            )
        conn.commit()
    finally:
        conn.close()


def resolve_billing_alerts(account_id: str, resolved_at: datetime):
    """Marca como resueltas todas las alertas abiertas de una cuenta."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE automations.billing_alerts
                   SET "resolvedAt" = %s
                   WHERE "accountId" = %s AND "resolvedAt" IS NULL""",
                (resolved_at, account_id)
            )
        conn.commit()
    finally:
        conn.close()


def get_open_billing_alerts() -> dict:
    """Devuelve alertas abiertas agrupadas por account_id."""
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT "accountId" AS account_id, MIN("alertedAt") as first_alert, MAX("alertedAt") as last_alert
                FROM automations.billing_alerts
                WHERE "resolvedAt" IS NULL
                GROUP BY "accountId"
            """)
            return {row["account_id"]: dict(row) for row in cur.fetchall()}
    finally:
        conn.close()


def automations_enabled() -> bool:
    """Lee el master switch. Si la fila no existe, asume habilitado."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT value FROM automations.system_flags WHERE key = 'automations_enabled'")
            row = cur.fetchone()
            return True if row is None else bool(row[0])
    finally:
        conn.close()
