"""Persistencia de estado en data/state.json y detección de transiciones OK/FAIL.

Solo se notifica a Slack cuando detect_transition() devuelve algo != None.
"""

import json
import os
import tempfile

from .models import CheckResult

STATE_PATH = os.environ.get("STATE_PATH", "data/state.json")


def load_state() -> dict:
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE_PATH) or ".", exist_ok=True)
    # Escritura atómica: tmp + rename, para no corromper el json si se mata el proceso.
    dir_name = os.path.dirname(STATE_PATH) or "."
    fd, tmp = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        os.replace(tmp, STATE_PATH)
        # Legible por el contenedor del panel web (que comparte el volumen data/).
        try:
            os.chmod(STATE_PATH, 0o644)
        except OSError:
            pass
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def detect_transition(prev_status: str | None, result: CheckResult) -> str | None:
    """Devuelve 'to_fail', 'to_ok' o None.

    - prev OK/None y result.ok=False ⇒ 'to_fail'
    - prev FAIL  y result.ok=True   ⇒ 'to_ok'
    - sin cambio                    ⇒ None
    """
    if result.ok:
        if prev_status == "FAIL":
            return "to_ok"
        return None
    else:
        if prev_status in (None, "OK"):
            return "to_fail"
        return None
