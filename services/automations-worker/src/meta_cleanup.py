"""
meta_cleanup — elimina ads DISAPPROVED y adsets huérfanos.
Corre a las 7am CO. Ejecuta directamente (sin dry-run por defecto).
"""

import json
import urllib.request
import urllib.parse
import logging
from datetime import datetime, timedelta, timezone

from . import config as cfg_module
from . import db as db_module
from .update_sheet import get_all_accounts

log = logging.getLogger(__name__)

COL_TZ = timezone(timedelta(hours=-5))
FB_API_VERSION = "v21.0"


def _load_cfg() -> dict:
    cfg = cfg_module.load_config()
    token = cfg.get("meta_controller_token", "")
    slack_webhook = cfg.get("slack_webhook_controller", "")
    return {"token": token, "slack_webhook": slack_webhook}


def _call_api(url: str, token: str, method: str = "GET", params: dict = None) -> dict:
    if params is None:
        params = {}
    params["access_token"] = token
    if method == "GET":
        full_url = f"{url}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(full_url)
    else:
        data = urllib.parse.urlencode(params).encode()
        req = urllib.request.Request(url, data=data, method=method)
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read())


def _paginate(url: str, token: str, params: dict):
    """Obtiene todos los resultados paginados. Devuelve (items, error)."""
    items = []
    params = dict(params)
    params["limit"] = 200
    next_url = url
    while next_url:
        try:
            if next_url == url:
                data = _call_api(next_url, token, params=params)
            else:
                req_params = {"access_token": token}
                full_url = f"{next_url}&{urllib.parse.urlencode(req_params)}"
                req = urllib.request.Request(full_url)
                resp = urllib.request.urlopen(req, timeout=30)
                data = json.loads(resp.read())
            items.extend(data.get("data", []))
            next_url = data.get("paging", {}).get("next")
        except Exception as e:
            log.error("Pagination error at %s: %s", next_url, e)
            return items, str(e)
    return items, None


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


def _process_account(account_id: str, account_name: str, token: str, api_version: str, dry_run: bool) -> dict:
    if not token:
        return {"account_id": account_id, "name": account_name,
                "error": "Token no configurado",
                "deleted_ads": [], "deleted_adsets": []}

    deleted_ads = []
    deleted_adsets = []
    errors = []

    # 1. Obtener todos los ads DISAPPROVED
    ads_url = f"https://graph.facebook.com/{api_version}/{account_id}/ads"
    ads, ads_err = _paginate(ads_url, token, {
        "fields": "id,name,status,effective_status,adset_id",
        "effective_status": json.dumps(["DISAPPROVED"]),
    })
    if ads_err and not ads:
        return {"account_id": account_id, "name": account_name,
                "error": f"Error fetching ads: {ads_err}",
                "deleted_ads": [], "deleted_adsets": []}

    # 2. Eliminar ads DISAPPROVED
    for ad in ads:
        ad_id = ad["id"]
        ad_name = ad.get("name", ad_id)
        if dry_run:
            log.info("DRY-RUN: delete ad %s (%s)", ad_id, ad_name)
            deleted_ads.append({"id": ad_id, "name": ad_name})
            continue
        try:
            url = f"https://graph.facebook.com/{api_version}/{ad_id}"
            _call_api(url, token, method="DELETE")
            deleted_ads.append({"id": ad_id, "name": ad_name})
            log.info("Deleted ad %s (%s) in %s", ad_id, ad_name, account_name)
        except Exception as e:
            errors.append(f"Ad {ad_id}: {e}")
            log.error("Error deleting ad %s: %s", ad_id, e)

    # 3. Obtener todos los adsets activos para encontrar huérfanos
    adsets_url = f"https://graph.facebook.com/{api_version}/{account_id}/adsets"
    adsets, adsets_err = _paginate(adsets_url, token, {
        "fields": "id,name,status,effective_status",
        "effective_status": json.dumps(["ACTIVE", "PAUSED"]),
    })
    if adsets_err and not adsets:
        errors.append(f"Error fetching adsets: {adsets_err}")

    # 4. Para cada adset, verificar si tiene ads activos/en_revisión
    for adset in adsets:
        adset_id = adset["id"]
        adset_name = adset.get("name", adset_id)
        ads_in_adset_url = f"https://graph.facebook.com/{api_version}/{adset_id}/ads"
        ads_in_adset, adset_ads_err = _paginate(ads_in_adset_url, token, {
            "fields": "id,effective_status",
            "effective_status": json.dumps(["ACTIVE", "PAUSED", "PENDING_REVIEW", "IN_PROCESS"]),
        })
        if adset_ads_err:
            # No podemos saber si está vacío — skip para no eliminar por error
            continue

        if not ads_in_adset:
            # Adset huérfano: sin ads válidos → eliminar
            if dry_run:
                log.info("DRY-RUN: delete orphan adset %s (%s)", adset_id, adset_name)
                deleted_adsets.append({"id": adset_id, "name": adset_name})
                continue
            try:
                url = f"https://graph.facebook.com/{api_version}/{adset_id}"
                _call_api(url, token, method="DELETE")
                deleted_adsets.append({"id": adset_id, "name": adset_name})
                log.info("Deleted orphan adset %s (%s) in %s", adset_id, adset_name, account_name)
            except Exception as e:
                errors.append(f"Adset {adset_id}: {e}")
                log.error("Error deleting adset %s: %s", adset_id, e)

    return {
        "account_id": account_id,
        "name": account_name,
        "deleted_ads": deleted_ads,
        "deleted_adsets": deleted_adsets,
        "errors": errors,
    }


def run(task=None, dry_run: bool = False):
    log.info("meta_cleanup: inicio (dry_run=%s)", dry_run)
    started_at = datetime.now(timezone.utc)

    try:
        conf = _load_cfg()
    except Exception as e:
        log.error("meta_cleanup: error cargando config: %s", e)
        return

    token = conf["token"]
    slack_webhook = conf["slack_webhook"]

    fb_accounts = get_all_accounts(token)
    if task is not None:
        fb_accounts = task.filter_accounts(fb_accounts)
    if not fb_accounts:
        log.warning("meta_cleanup: no se encontraron cuentas activas en el token")
        return

    now_str = datetime.now(COL_TZ).strftime("%Y-%m-%d %H:%M")
    mode_label = "DRY-RUN" if dry_run else "EXECUTE"

    results = []
    for account_id, account_name in fb_accounts.items():
        result = _process_account(account_id, account_name, token, FB_API_VERSION, dry_run)
        results.append(result)

    # Reporte Slack
    total_ads = sum(len(r.get("deleted_ads", [])) for r in results)
    total_adsets = sum(len(r.get("deleted_adsets", [])) for r in results)
    accounts_with_work = [r for r in results if r.get("deleted_ads") or r.get("deleted_adsets")]

    if total_ads > 0 or total_adsets > 0:
        lines = []
        for r in accounts_with_work:
            lines.append(f"  *{r['name']}*")
            if r.get("deleted_ads"):
                lines.append(f"    Ads DISAPPROVED eliminados: {len(r['deleted_ads'])}")
            if r.get("deleted_adsets"):
                lines.append(f"    Adsets huérfanos eliminados: {len(r['deleted_adsets'])}")
        msg = (
            f"🧹 *Meta Cleanup [{mode_label}]* — {now_str} COL\n"
            f"Ads DISAPPROVED: *{total_ads}* | Adsets huérfanos: *{total_adsets}*\n\n"
            + "\n".join(lines)
        )
        _send_slack(slack_webhook, msg)
    else:
        msg = (f"✅ *Meta Cleanup [{mode_label}]* — {now_str} COL\n"
               f"Sin ads DISAPPROVED ni adsets huérfanos.")
        _send_slack(slack_webhook, msg)

    errors_list = [e for r in results for e in r.get("errors", [])]
    if errors_list:
        err_text = "\n".join(f"  • {e}" for e in errors_list[:20])
        _send_slack(slack_webhook, f"⚠️ *Meta Cleanup — Errores ({len(errors_list)}):*\n{err_text}")

    finished_at = datetime.now(timezone.utc)
    db_module.save_job_run(
        "meta_disapproved_cleanup", started_at, finished_at, True,
        {"total_ads_deleted": total_ads, "total_adsets_deleted": total_adsets,
         "accounts_processed": len(results), "dry_run": dry_run}
    )
    log.info("meta_cleanup: fin — %d ads, %d adsets eliminados", total_ads, total_adsets)
