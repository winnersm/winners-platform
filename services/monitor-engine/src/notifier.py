"""Notificaciones a Slack vía Incoming Webhook (Block Kit + attachment con color).

Si el POST falla, se loguea pero NUNCA se crashea el ciclo.
"""

import logging
import os

import requests

from .models import CheckResult

logger = logging.getLogger("link-monitor.notifier")

SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "").strip()

COLOR_FAIL = "#E01E5A"   # rojo
COLOR_OK = "#2EB67D"     # verde
COLOR_WARN = "#ECB22E"   # amarillo (lentitud: no es caída, es advertencia)


def classify_failure(failures: list[str]) -> tuple[str, str, str]:
    """Decide ícono, título y color según QUÉ falló (prioridad: lo más grave primero).

    Devuelve (emoji, titulo, color). Un solo 'Lento' es advertencia (amarillo);
    cualquier desvío/caída/lander roto es rojo.
    """
    text = " | ".join(failures).lower()
    if "destino final inesperado" in text:
        return ("🚨", "LINK DESVIADO", COLOR_FAIL)
    if any(k in text for k in (
        "timeout", "error de red", "status final", "salto con error", "no hubo redirección",
    )):
        return ("🔴", "LINK CAÍDO", COLOR_FAIL)
    if "no encontrado en el lander" in text:
        return ("⚠️", "LANDER ROTO", COLOR_FAIL)
    if "lento" in text:
        return ("🐢", "LINK LENTO", COLOR_WARN)
    return ("🔴", "FALLO", COLOR_FAIL)


def _post(payload: dict) -> None:
    if not SLACK_WEBHOOK_URL:
        logger.warning("SLACK_WEBHOOK_URL ausente — modo solo-log. Payload: %s",
                       payload.get("_summary", ""))
        return
    try:
        resp = requests.post(SLACK_WEBHOOK_URL, json=payload, timeout=10)
        if resp.status_code != 200:
            logger.error("Slack respondió %s: %s", resp.status_code, resp.text[:300])
    except requests.exceptions.RequestException as e:
        logger.error("No se pudo postear a Slack: %s", e)


def _chain_str(chain: list[str]) -> str:
    return " → ".join(chain) if chain else "(sin cadena)"


def notify_fail(result: CheckResult) -> None:
    emoji, titulo, color = classify_failure(result.failures)
    failures = "\n".join(f"• {f}" for f in result.failures) or "• (sin detalle)"
    text = (
        f"{emoji} *{titulo}* — {result.name}\n\n"
        f"*Falló:*\n{failures}\n\n"
        f"*Destino final:* {result.final_url or '(ninguno)'}\n"
        f"*Status:* {result.status_final} | *Tiempo:* {result.response_ms}ms\n"
        f"*Cadena:* {_chain_str(result.redirect_chain)}\n"
        f"*Detectado:* {result.checked_at}"
    )
    payload = {
        "_summary": f"{titulo} {result.name}",
        "attachments": [
            {
                "color": color,
                "blocks": [
                    {"type": "section", "text": {"type": "mrkdwn", "text": text}}
                ],
            }
        ],
    }
    _post(payload)


def notify_recovery(result: CheckResult, since: str) -> None:
    text = (
        f"✅ *RECUPERADO* — {result.name}\n"
        f"Estuvo caído desde {since}. Volvió a OK."
    )
    payload = {
        "_summary": f"RECOVERY {result.name}",
        "attachments": [
            {
                "color": COLOR_OK,
                "blocks": [
                    {"type": "section", "text": {"type": "mrkdwn", "text": text}}
                ],
            }
        ],
    }
    _post(payload)
