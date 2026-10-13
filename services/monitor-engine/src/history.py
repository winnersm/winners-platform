"""Historial de incidentes en data/incidents.jsonl (una línea JSON por transición).

Lo escribe el monitor en cada transición OK↔FAIL; lo lee el panel web para mostrar
el log de caídas/recuperaciones. Append-only, barato, sin DB.
"""

import json
import os

INCIDENTS_PATH = os.environ.get("INCIDENTS_PATH", "data/incidents.jsonl")


def append_incident(name: str, kind: str, detail: str, ts: str, final_url: str | None = None) -> None:
    """kind: 'FAIL' | 'RECOVERY'."""
    os.makedirs(os.path.dirname(INCIDENTS_PATH) or ".", exist_ok=True)
    row = {"ts": ts, "name": name, "kind": kind, "detail": detail, "final_url": final_url}
    with open(INCIDENTS_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    try:
        os.chmod(INCIDENTS_PATH, 0o644)
    except OSError:
        pass


def read_incidents(limit: int = 50) -> list[dict]:
    """Devuelve los últimos `limit` incidentes, más recientes primero."""
    try:
        with open(INCIDENTS_PATH, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return []
    rows = []
    for line in lines[-limit:]:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    rows.reverse()
    return rows
