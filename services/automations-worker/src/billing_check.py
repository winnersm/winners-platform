"""
billing_check — consulta estado de cuentas Meta Ads cada 30 min.
Estado previo se lee/escribe en PostgreSQL (no Google Sheet).
"""

import json
import urllib.request
import urllib.parse
import logging
from datetime import datetime, timedelta, timezone

from . import config as cfg_module
from . import db
from .update_sheet import get_all_accounts

log = logging.getLogger(__name__)

COL_TZ = timezone(timedelta(hours=-5))
REMINDER_HOURS = 4

BILLING_FIELDS = "id,name,account_id,account_status,disable_reason,balance,amount_spent,spend_cap,currency,funding_source,business"

ACCOUNT_STATUS_LABELS = {
    1:   "Activa",
    2:   "Deshabilitada",
    3:   "Deuda pendiente (Unsettled)",
    7:   "En revisión de riesgo",
    8:   "Pago pendiente (Pending Settlement)",
    9:   "Período de gracia (Grace Period)",
    100: "Pendiente de cierre",
    101: "Cerrada",
}

CRITICAL_STATUSES = {2, 3, 7, 8, 9, 100, 101}

DISABLE_REASON_LABELS = {
    0:  None,
    1:  "Violación de política de anuncios",
    2:  "Requiere verificación de negocio",
    3:  "Riesgo de pago",
    4:  "Cuenta bloqueada",
    5:  "En revisión interna de Meta",
    6:  "Problema de integridad del negocio",
    7:  "Deshabilitada permanentemente",
    8:  "Violación de política de publisher",
    9:  "Bloqueada por publisher",
    10: "Deshabilitada manualmente",
    11: "Crédito insuficiente",
}


def _send_slack(webhook: str, message: str):
    try:
        data = json.dumps({"text": message}).encode()
        req = urllib.request.Request(webhook, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        log.warning("Slack error: %s", e)


def _build_config(cfg: dict) -> dict:
    fb_token = cfg.get("fb_token_primary", "")
    return {
        "fb_token": fb_token,
        "slack_webhook": cfg.get("slack_webhook_billing", ""),
    }


def _fetch_billing_statuses(fb_accounts: dict, fb_token: str) -> dict:
    account_ids = list(fb_accounts.keys())
    if not account_ids:
        return {}
    return _fetch_batch(account_ids, [fb_token] if fb_token else [])


def _fetch_batch(account_ids: list, tokens: list) -> dict:
    last_err = "unknown"
    for token in tokens:
        batch = [
            {"method": "GET", "relative_url": f"{aid}?fields={BILLING_FIELDS}"}
            for aid in account_ids
        ]
        data = urllib.parse.urlencode({
            "access_token": token,
            "batch": json.dumps(batch)
        }).encode()
        try:
            req = urllib.request.Request("https://graph.facebook.com/v21.0/", data=data, method="POST")
            resp = urllib.request.urlopen(req, timeout=45)
            batch_results = json.loads(resp.read())

            results = {}
            all_failed = True
            for i, item in enumerate(batch_results):
                aid = account_ids[i]
                if item and item.get("code") == 200:
                    body = json.loads(item["body"])
                    if "error" in body:
                        err = body["error"]
                        err_msg = err.get("message", "?")
                        level = "timeout" if "timed out" in err_msg.lower() else "tech_error"
                        results[aid] = {"level": level, "error_msg": err_msg[:80], "error_code": err.get("code", 0)}
                    else:
                        all_failed = False
                        status = body.get("account_status", -1)
                        disable_reason = body.get("disable_reason", 0)
                        funding_source = body.get("funding_source")
                        try:
                            raw = body.get("balance", "0")
                            balance = float(raw) / 100 if isinstance(raw, int) else float(raw)
                        except (ValueError, TypeError):
                            balance = 0.0
                        currency = body.get("currency", "USD")
                        level = "ok"
                        if status in CRITICAL_STATUSES:
                            level = "critical"
                        elif disable_reason not in (0, None) or not funding_source or (balance > 0 and status in {3, 8, 9}):
                            level = "warning"
                        results[aid] = {
                            "level": level,
                            "status": status,
                            "label": ACCOUNT_STATUS_LABELS.get(status, f"Unknown ({status})"),
                            "disable_reason": disable_reason,
                            "balance": balance,
                            "currency": currency,
                            "funding_source": funding_source,
                            "name": body.get("name", aid),
                        }
                else:
                    all_failed = False
                    err_msg = f"HTTP {item.get('code', '?')}" if item else "No response"
                    try:
                        err_body = json.loads(item.get("body", "{}"))
                        err_msg = err_body.get("error", {}).get("message", err_msg)[:80]
                    except Exception:
                        pass
                    level = "timeout" if "timed out" in err_msg.lower() else "tech_error"
                    results[aid] = {"level": level, "error_msg": err_msg, "error_code": 0}

            if not all_failed:
                return results
            last_err = next(iter(results.values()), {}).get("error_msg", "unknown")
        except Exception as e:
            last_err = str(e)

    return {aid: {"level": "timeout", "error_msg": f"All tokens failed: {last_err}"} for aid in account_ids}


def _format_line(acc_name: str, result: dict) -> str:
    if result["level"] in ("tech_error", "timeout"):
        return f"  • *{acc_name}* — Error técnico: {result.get('error_msg', '?')[:80]}"
    status_label = result["label"]
    disable_reason = result.get("disable_reason")
    reason_text = DISABLE_REASON_LABELS.get(disable_reason) if disable_reason not in (0, None) else None
    balance = result.get("balance", 0)
    currency = result.get("currency", "USD")
    has_payment = bool(result.get("funding_source"))

    parts = []
    if reason_text:
        parts.append(reason_text)
    else:
        parts.append(status_label)
    if balance and balance > 0:
        parts.append(f"Deuda: ${balance:,.2f} {currency}")
    if not has_payment:
        parts.append("Sin método de pago")
    return f"  • *{acc_name}* — " + " | ".join(parts)


def run(task=None):
    log.info("billing_check: inicio")
    started_at = datetime.now(timezone.utc)

    try:
        cfg = cfg_module.load_config()
    except Exception as e:
        log.error("billing_check: error cargando config: %s", e)
        return

    bc = _build_config(cfg)
    fb_accounts: dict = get_all_accounts(bc["fb_token"], active_only=False)
    if task is not None:
        fb_accounts = task.filter_accounts(fb_accounts)
    if not fb_accounts:
        log.warning("billing_check: no se encontraron cuentas en el token")
        return

    now = datetime.now(COL_TZ)
    now_str = now.strftime("%Y-%m-%d %H:%M")

    current_results = _fetch_billing_statuses(fb_accounts, bc["fb_token"])

    # Leer estado previo de PostgreSQL
    prev_snapshots = db.get_latest_account_snapshots()
    open_alerts = db.get_open_billing_alerts()

    new_issues, resolved = [], []
    snapshots_to_save = []

    for aid, result in current_results.items():
        acc_name = fb_accounts.get(aid, aid)
        level = result["level"]

        if level == "timeout":
            continue

        # Snapshot para persistir
        snapshots_to_save.append({
            "account_id": aid,
            "account_name": acc_name,
            "status_code": result.get("status"),
            "status_label": result.get("label"),
            "level": level,
            "balance": result.get("balance"),
            "currency": result.get("currency"),
            "error_msg": result.get("error_msg"),
        })

        prev = prev_snapshots.get(aid, {})
        prev_level = prev.get("level", "ok")
        is_problem = level in ("critical", "warning", "tech_error")
        was_problem = prev_level in ("critical", "warning", "tech_error")

        if is_problem and not was_problem:
            new_issues.append((aid, acc_name, result))
        elif not is_problem and was_problem:
            resolved.append((aid, acc_name, result))

    # Guardar snapshots
    if snapshots_to_save:
        db.save_account_snapshots(snapshots_to_save, now)

    # Alertas Slack
    webhook = bc["slack_webhook"]
    sections = []
    if new_issues:
        critical = [(a, n, r) for a, n, r in new_issues if r["level"] == "critical"]
        warning  = [(a, n, r) for a, n, r in new_issues if r["level"] == "warning"]
        tech     = [(a, n, r) for a, n, r in new_issues if r["level"] == "tech_error"]
        ok_count = len(fb_accounts) - len(new_issues)

        sections.append(f"🚨 *Meta Ads — {len(new_issues)} cuenta(s) con problema*\n_{now_str} COL_")
        if critical:
            lines = "\n".join(_format_line(n, r) for _, n, r in critical)
            sections.append(f"❌ *No pueden gastar ({len(critical)}):*\n{lines}")
        if warning:
            lines = "\n".join(_format_line(n, r) for _, n, r in warning)
            sections.append(f"⚠️ *Revisar billing ({len(warning)}):*\n{lines}")
        if tech:
            lines = "\n".join(_format_line(n, r) for _, n, r in tech)
            sections.append(f"🛠️ *Error de API ({len(tech)}):*\n{lines}")
        if ok_count > 0:
            sections.append(f"✅ *{ok_count} cuenta(s) corriendo normal*")
        sections.append("👉 _Meta Ads Manager → Account Quality_")

        for aid, acc_name, result in new_issues:
            db.save_billing_alert(aid, acc_name, result["level"],
                                  _format_line(acc_name, result), now)

    if resolved:
        for aid, acc_name, _ in resolved:
            db.resolve_billing_alerts(aid, now)
        res_lines = "\n".join(f"  • *{n}* — volvió a activa ✅" for _, n, _ in resolved)
        sections.append(f"✅ *Meta Ads — Cuenta(s) reactivada(s)*\n_{now_str} COL_\n\n{res_lines}")

    if sections and webhook:
        _send_slack(webhook, "\n\n".join(sections))

    finished_at = datetime.now(timezone.utc)
    result_summary = {
        "accounts_checked": len(current_results),
        "new_issues": len(new_issues),
        "resolved": len(resolved),
        "alerted": bool(sections),
    }
    db.save_job_run("billing_check", started_at, finished_at, True, result_summary)
    log.info("billing_check: fin — %s", result_summary)
