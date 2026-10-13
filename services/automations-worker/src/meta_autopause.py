"""
meta_autopause — pausa campañas de Meta Ads sin conversiones.
Corre a las 8am CO. Ejecuta con execute=True desde APScheduler.
"""

import json
import urllib.request
import urllib.parse
import logging
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import config as cfg_module
from . import db as db_module
from .update_sheet import get_all_accounts

log = logging.getLogger(__name__)

COL_TZ = timezone(timedelta(hours=-5))
FB_API_VERSION = "v21.0"


def _load_cfg() -> dict:
    cfg = cfg_module.load_config()
    token = cfg.get("meta_controller_token", "")
    rule_raw = cfg.get("autopause_rule_json", "{}")
    slack_webhook = cfg.get("slack_webhook_controller", "")
    rule = json.loads(rule_raw) if rule_raw else {}
    version = rule.get("fb_api_version", FB_API_VERSION)
    return {
        "token": token,
        "rule": rule,
        "slack_webhook": slack_webhook,
        "api_version": version,
    }


def _call_api(url: str, token: str, method: str = "GET", params: dict = None) -> dict:
    if params:
        params["access_token"] = token
    else:
        params = {"access_token": token}

    if method == "GET":
        full_url = f"{url}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(full_url)
    else:
        data = urllib.parse.urlencode(params).encode()
        req = urllib.request.Request(url, data=data, method=method)

    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read())


def _send_slack(webhook: str, message: str):
    if not webhook:
        return
    try:
        data = json.dumps({"text": message}).encode()
        req = urllib.request.Request(webhook, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        log.warning("Slack error: %s", e)


def _get_campaigns_insights(account_id: str, token: str, rule: dict, api_version: str) -> list:
    """Obtiene campañas activas con insights del período de lookback."""
    lookback = rule.get("lookback_days", 7)
    min_spend = rule.get("min_spend_usd", 100.0)
    action_type = rule.get("purchase_action_type", "purchase")
    min_traffic_days = rule.get("min_traffic_days", 3)

    since = (datetime.now(COL_TZ) - timedelta(days=lookback)).strftime("%Y-%m-%d")
    until = datetime.now(COL_TZ).strftime("%Y-%m-%d")

    url = f"https://graph.facebook.com/{api_version}/{account_id}/campaigns"
    params = {
        "fields": "id,name,status,effective_status",
        "effective_status": json.dumps(["ACTIVE"]),
        "limit": 200,
    }
    try:
        data = _call_api(url, token, params=params)
    except Exception as e:
        log.error("Error fetching campaigns for %s: %s", account_id, e)
        return []

    campaigns = data.get("data", [])
    if not campaigns:
        return []

    batch = [{
        "method": "GET",
        "relative_url": (
            f"{c['id']}/insights?fields=spend,actions,action_values"
            f"&time_range={urllib.parse.quote(json.dumps({'since': since, 'until': until}))}"
            f"&time_increment=1&limit=50"
        )
    } for c in campaigns]

    batch_data = urllib.parse.urlencode({
        "access_token": token,
        "batch": json.dumps(batch)
    }).encode()
    try:
        req = urllib.request.Request(f"https://graph.facebook.com/{api_version}/", data=batch_data, method="POST")
        resp = urllib.request.urlopen(req, timeout=60)
        batch_results = json.loads(resp.read())
    except Exception as e:
        log.error("Error batch insights for %s: %s", account_id, e)
        return []

    to_pause = []
    for i, item in enumerate(batch_results):
        camp = campaigns[i]
        if not item or item.get("code") != 200:
            continue
        body = json.loads(item["body"])
        daily_entries = body.get("data", [])
        if not daily_entries:
            continue

        total_spend = sum(float(e.get("spend", 0)) for e in daily_entries)
        traffic_days = len([e for e in daily_entries if float(e.get("spend", 0)) > 0])
        total_purchases = 0
        for e in daily_entries:
            for ac in e.get("actions", []):
                if ac.get("action_type") == action_type:
                    total_purchases += int(ac.get("value", 0))

        if (traffic_days >= min_traffic_days
                and total_spend >= min_spend
                and total_purchases == 0):
            daily_spends = [round(float(e.get("spend", 0)), 2) for e in daily_entries if float(e.get("spend", 0)) > 0]
            to_pause.append({
                "campaign_id": camp["id"],
                "campaign_name": camp["name"],
                "total_spend": round(total_spend, 2),
                "traffic_days": traffic_days,
                "daily_spends": daily_spends,
                "purchases": 0,
            })

    return to_pause


def _pause_campaign(campaign_id: str, token: str, api_version: str, dry_run: bool) -> bool:
    if dry_run:
        log.info("DRY-RUN: pause campaign %s", campaign_id)
        return True
    url = f"https://graph.facebook.com/{api_version}/{campaign_id}"
    try:
        _call_api(url, token, method="POST", params={"status": "PAUSED"})
        return True
    except Exception as e:
        log.error("Error pausing campaign %s: %s", campaign_id, e)
        return False


def _process_account(account_id: str, account_name: str, token: str,
                     rule: dict, api_version: str, execute: bool) -> dict:
    if not token:
        return {"account_id": account_id, "name": account_name,
                "error": "Token no configurado", "paused": []}

    candidates = _get_campaigns_insights(account_id, token, rule, api_version)

    paused = []
    errors = []
    for c in candidates:
        success = _pause_campaign(c["campaign_id"], token, api_version, dry_run=not execute)
        if success:
            paused.append(c)
        else:
            errors.append(c["campaign_id"])

    return {
        "account_id": account_id,
        "name": account_name,
        "candidates": len(candidates),
        "paused": paused,
        "errors": errors,
    }


def run(task=None, execute: bool = True):
    log.info("meta_autopause: inicio (execute=%s)", execute)
    started_at = datetime.now(timezone.utc)

    try:
        conf = _load_cfg()
    except Exception as e:
        log.error("meta_autopause: error cargando config: %s", e)
        return

    token = conf["token"]
    rule = conf["rule"]
    api_version = conf["api_version"]
    slack_webhook = conf["slack_webhook"]

    fb_accounts = get_all_accounts(token)
    if task is not None:
        fb_accounts = task.filter_accounts(fb_accounts)
    if not fb_accounts:
        log.warning("meta_autopause: no se encontraron cuentas activas en el token")
        return

    results = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(_process_account, acc_id, acc_name, token, rule, api_version, execute): acc_id
            for acc_id, acc_name in fb_accounts.items()
        }
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as e:
                acc_id = futures[future]
                results.append({"account_id": acc_id, "name": acc_id,
                                 "error": str(e), "paused": []})

    total_paused = sum(len(r.get("paused", [])) for r in results)
    accounts_with_pauses = [r for r in results if r.get("paused")]
    date_str = datetime.now(COL_TZ).strftime("%Y-%m-%d")
    if total_paused > 0:
        lines = []
        total_lost = sum(c["total_spend"] for r in accounts_with_pauses for c in r["paused"])
        for r in accounts_with_pauses:
            for c in r["paused"]:
                daily_str = " + ".join(f"${d}" for d in c["daily_spends"])
                lines.append(
                    f"• *{r['name']}* ( `{r['account_id']}` )\n"
                    f"  └ {c['campaign_name']}\n"
                    f"  {c['traffic_days']} días: {daily_str} = ${c['total_spend']} | Purchases: 0"
                )
        msg = (
            f"⏸️ *Auto-pause Meta Ads — {date_str}*\n\n"
            f"{total_paused} campañas pausadas:\n\n"
            + "\n\n".join(lines)
            + f"\n\n*Total gasto perdido detectado: ${round(total_lost, 2)}*"
        )
        _send_slack(slack_webhook, msg)
    else:
        msg = (f"✅ *Auto-pause Meta Ads — {date_str}*\n"
               f"No se encontraron campañas que cumplan el criterio de pausa.")
        _send_slack(slack_webhook, msg)

    errors_accounts = [r for r in results if r.get("error")]
    if errors_accounts:
        err_lines = [f"  • {r['name']}: {r['error']}" for r in errors_accounts]
        _send_slack(slack_webhook, f"⚠️ *Meta Auto-Pause — Errores:*\n" + "\n".join(err_lines))

    finished_at = datetime.now(timezone.utc)
    db_module.save_job_run(
        "meta_autopause", started_at, finished_at, True,
        {"total_paused": total_paused, "accounts_processed": len(results), "execute": execute}
    )
    log.info("meta_autopause: fin — %d pausadas", total_paused)
