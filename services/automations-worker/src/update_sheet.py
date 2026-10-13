"""
update_sheet — actualiza el Google Sheet de spend/revenue y reporta en Slack.
- run_intraday(): cada 30 min (7am-8pm COL) — Live Tracker en Slack
- run_daily(): 1am COL — escribe día anterior en Google Sheet
"""

import json
import urllib.request
import urllib.parse
import base64
import re
import logging
import time as _time
from datetime import datetime, timedelta, timezone
import calendar

import gspread
from google.oauth2.service_account import Credentials

from . import config as cfg_module
from . import db as db_module

log = logging.getLogger(__name__)

COL_TZ = timezone(timedelta(hours=-5))
JVZOO_TZ = timezone(timedelta(hours=-4))

MONTH_NAMES = {
    1: "January", 2: "February", 3: "March", 4: "April",
    5: "May", 6: "June", 7: "July", 8: "August",
    9: "September", 10: "October", 11: "November", 12: "December"
}


# ─────────────────────────── Helpers ───────────────────────────

def _fmt(v: float) -> str:
    """Formato colombiano: 105.802,51 (punto=miles, coma=decimal)."""
    neg = v < 0
    int_part, dec_part = f"{abs(v):.2f}".split(".")
    groups = []
    while len(int_part) > 3:
        groups.append(int_part[-3:])
        int_part = int_part[:-3]
    groups.append(int_part)
    return ("-" if neg else "") + ".".join(reversed(groups)) + "," + dec_part


def _send_slack(webhook: str, message: str):
    try:
        data = json.dumps({"text": message}).encode()
        req = urllib.request.Request(webhook, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        log.warning("Slack error: %s", e)


def col_index_to_letter(idx):
    result = ""
    while idx >= 0:
        result = chr(65 + idx % 26) + result
        idx = idx // 26 - 1
    return result


def extract_account_key(header_text):
    text = header_text.replace("\n", " ").strip()
    if not text:
        return None
    patterns = [
        r'(RPG\s*\d+)', r'(THM-\d+)', r'(GM-\d+)',
        r'(SC2-\d+)', r'(DG-\d+)', r'(KM-\d+)', r'(MSTC-\d+)',
        r'(DFU\d+-\w+)',
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1).upper().strip()
    return None


# ─────────────────────────── Meta API ───────────────────────────

def get_all_accounts(token: str, active_only: bool = True) -> dict:
    """Devuelve {act_id: name} para las cuentas del token vía /me/adaccounts.
    active_only=True (default) retorna solo account_status==1. False retorna todas."""
    params = urllib.parse.urlencode({
        "access_token": token,
        "fields": "name,account_status",
        "limit": "500",
    })
    try:
        req = urllib.request.Request(f"https://graph.facebook.com/v21.0/me/adaccounts?{params}")
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read())
        accounts = {
            acc["id"]: acc["name"]
            for acc in data.get("data", [])
            if not active_only or acc.get("account_status") == 1
        }
        log.info("get_all_accounts: %d cuentas encontradas (active_only=%s)", len(accounts), active_only)
        return accounts
    except Exception as e:
        log.warning("get_all_accounts error: %s", e)
        return {}


def get_fb_spend_batch(account_ids: list, date_str: str, fb_tokens: list):
    time_range = json.dumps({"since": date_str, "until": date_str})
    results = {}
    pending = list(account_ids)
    last_error = None

    for token in fb_tokens:
        if not pending:
            break
        batch = [{
            "method": "GET",
            "relative_url": (
                f"{acc_id}/insights?fields=spend,actions,action_values"
                f"&time_range={urllib.parse.quote(time_range)}&time_increment=1"
            )
        } for acc_id in pending]

        data = urllib.parse.urlencode({
            "access_token": token,
            "batch": json.dumps(batch)
        }).encode()

        try:
            req = urllib.request.Request("https://graph.facebook.com/v21.0/", data=data, method="POST")
            resp = urllib.request.urlopen(req, timeout=30)
            batch_results = json.loads(resp.read())
        except Exception as e:
            last_error = str(e)
            continue

        still_pending = []
        for i, item in enumerate(batch_results):
            acc_id = pending[i]
            if item and item.get("code") == 200:
                body = json.loads(item["body"])
                entries = body.get("data", [])
                if entries:
                    entry = entries[0]
                    spend = float(entry.get("spend", 0))
                    fb_revenue = 0.0
                    for av in entry.get("action_values", []):
                        if av.get("action_type") == "offsite_conversion.fb_pixel_purchase":
                            fb_revenue = float(av.get("value", 0))
                            break
                    fb_purchases = 0
                    for ac in entry.get("actions", []):
                        if ac.get("action_type") == "offsite_conversion.fb_pixel_purchase":
                            fb_purchases = int(ac.get("value", 0))
                            break
                    results[acc_id] = {"spend": spend, "fb_revenue": fb_revenue, "fb_purchases": fb_purchases}
                else:
                    results[acc_id] = {"spend": 0.0, "fb_revenue": 0.0, "fb_purchases": 0}
            else:
                code = item.get("code", "null") if item else "null"
                try:
                    err_body = json.loads(item.get("body", "{}")).get("error", {}).get("message", "")[:80] if item else ""
                except Exception:
                    err_body = ""
                last_error = f"{acc_id} code={code}: {err_body}"
                still_pending.append(acc_id)

        pending = still_pending

    error_msg = None
    if pending:
        error_msg = f"FB spend: {len(pending)}/{len(account_ids)} accounts failed: {last_error}"
        for acc_id in pending:
            results[acc_id] = {"spend": 0.0, "fb_revenue": 0.0, "fb_purchases": 0}

    return results, error_msg


# ─────────────────────────── Revenue APIs ───────────────────────────

def get_ds24_revenue(date_str: str, ds24_key: str):
    next_day = (datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    total = 0.0
    error = None
    for from_dt, to_dt in [
        (f"{date_str} 06:00:00", f"{date_str} 23:59:59"),
        (f"{next_day} 00:00:00", f"{next_day} 05:59:59"),
    ]:
        params = urllib.parse.urlencode({"from": from_dt, "to": to_dt, "search[role]": "affiliate", "page_size": 500})
        url = f"https://www.digistore24.com/api/call/listTransactions?{params}"
        req = urllib.request.Request(url)
        req.add_header("X-DS-API-KEY", ds24_key)
        try:
            resp = urllib.request.urlopen(req, timeout=15)
            data = json.loads(resp.read())
            if data.get("result") == "error":
                error = f"DS24 API error: {data.get('message', 'unknown')}"
                continue
            amounts = data["data"]["summary"].get("amounts", {})
            if isinstance(amounts, dict):
                for curr, vals in amounts.items():
                    total += float(vals.get("earned_amount", 0))
        except Exception as e:
            error = f"DS24 request failed: {e}"
    return total, error if total == 0.0 and error else None


def get_jvzoo_revenue(date_str: str, jvzoo_key: str):
    """Revenue de JVZoo del día `date_str` (TZ -4).

    La API `latest-affiliates-transactions` ignora todo filtro de fecha/orden y
    siempre devuelve el historial completo en orden ASCENDENTE (más antiguas
    primero), paginando de a 100 vía cursor `transaction_id`. Re-recorrerlo
    entero en cada run crece sin límite y supera cualquier deadline.

    Para evitarlo persistimos un checkpoint: el transaction_id de la última
    transacción de un día ya cerrado (< date_str). Cada run arranca desde ahí y
    solo pagina las transacciones del día actual. El cursor avanza día a día.
    """
    auth = base64.b64encode(f"{jvzoo_key}:x".encode()).decode()
    base_url = "https://api.jvzoo.com/v2.0/latest-affiliates-transactions/"

    checkpoint = db_module.get_config_value("jvzoo_cursor")
    ckpt_date = db_module.get_config_value("jvzoo_cursor_date")

    # Si se pide un día anterior al que el cursor ya superó (p.ej. run_daily
    # reprocesando un día viejo), el checkpoint no sirve: escaneamos completo
    # desde el inicio y NO persistimos, para no retroceder el estado del tracker.
    if checkpoint and ckpt_date and date_str < ckpt_date:
        checkpoint = None
        persist = False
    else:
        persist = True

    # Solo confiamos en un checkpoint "vacío" si ya lo validamos hoy; de lo
    # contrario, el primer run del día hace fallback a escaneo completo si el
    # cursor no rinde resultados (protege contra un cursor corrupto).
    trust_empty = (ckpt_date == date_str)

    total = 0.0
    cursor = checkpoint
    new_checkpoint = checkpoint
    attempted_fallback = checkpoint is None  # sin checkpoint ya estamos en full scan
    max_pages = 200
    deadline = _time.monotonic() + 120

    page = 0
    while page < max_pages:
        if _time.monotonic() > deadline:
            return total, f"JVZoo: tiempo límite en página {page + 1}, parcial: ${total:,.2f}"

        url = f"{base_url}{cursor}" if cursor else base_url
        req = urllib.request.Request(url)
        req.add_header("Authorization", f"Basic {auth}")

        data = None
        end_pagination = False
        last_exc = None
        for attempt in range(3):
            if _time.monotonic() > deadline:
                break
            remaining = max(5, int(deadline - _time.monotonic()))
            try:
                resp = urllib.request.urlopen(req, timeout=min(12, remaining))
                raw = resp.read()
                if not raw or not raw.strip():
                    end_pagination = True
                    break
                data = json.loads(raw)
                break
            except json.JSONDecodeError:
                end_pagination = True
                break
            except Exception as e:
                last_exc = e
                continue

        if end_pagination:
            break
        if data is None:
            if total > 0:
                return total, f"JVZoo timeout en página {page + 1} (parcial ${total:,.2f}): {last_exc}"
            return total, f"JVZoo request failed on page {page + 1}: {last_exc}"

        if data.get("meta", {}).get("status", {}).get("http_status_code") != 200:
            msg = data.get("meta", {}).get("status", {}).get("message", "unknown")
            return total, f"JVZoo API error: {msg}"

        results = data.get("results", [])
        if not results:
            # El cursor no rindió nada. Si es la primera vez con un checkpoint no
            # validado hoy y aún no sumamos nada, reintentamos desde el inicio
            # (cursor posiblemente corrupto). Si no, asumimos "sin ventas nuevas".
            if cursor and not attempted_fallback and not trust_empty and total == 0.0:
                attempted_fallback = True
                cursor = None
                new_checkpoint = None
                page = 0
                continue
            break

        found_after = False
        new_cursor = results[-1]["transaction_id"]
        for tx in results:
            try:
                created_utc = datetime.strptime(tx["date"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
                tx_date = created_utc.astimezone(JVZOO_TZ).strftime("%Y-%m-%d")
            except Exception:
                continue
            if tx_date == date_str:
                total += float(tx.get("affiliate_commission") or 0)
            elif tx_date > date_str:
                found_after = True
            else:  # tx_date < date_str: día ya cerrado → avanza el checkpoint
                new_checkpoint = tx["transaction_id"]

        if found_after:
            break
        if cursor and new_cursor == cursor:
            break
        cursor = new_cursor
        if len(results) < 100:
            break
        page += 1

    # Recorrido completo sin timeout: persistimos el checkpoint para el próximo run.
    if persist:
        if new_checkpoint:
            db_module.set_config_value("jvzoo_cursor", new_checkpoint, "JVZoo cursor (interno)")
        db_module.set_config_value("jvzoo_cursor_date", date_str, "JVZoo cursor fecha (interno)")

    return total, None


def get_cb_revenue(date_str: str, cb_key: str):
    url = f"https://api.clickbank.com/rest/1.3/quickstats/count?startDate={date_str}&endDate={date_str}&account=natefb"
    req = urllib.request.Request(url)
    req.add_header("Authorization", cb_key)
    req.add_header("Accept", "application/json")
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        raw = resp.read().decode()
        if raw == "null" or not raw.strip():
            return 0.0, None
        data = json.loads(raw)
        sale = data.get("accountData", {}).get("quickStats", {}).get("sale", 0)
        return float(sale or 0), None
    except Exception as e:
        return 0.0, f"ClickBank request failed: {e}"


# ─────────────────────────── Sheet layout ───────────────────────────

def discover_sheet_layout(ws, fb_accounts: dict, fb_account_groups: dict):
    all_data = ws.get_all_values()
    if len(all_data) < 2:
        raise ValueError("Sheet has less than 2 rows")

    header_row_idx = None
    for i, row in enumerate(all_data):
        if row and row[0].strip().lower() == "date":
            header_row_idx = i
            break
    if header_row_idx is None:
        raise ValueError("Could not find header row with 'Date' in column A")

    headers = all_data[header_row_idx]
    col_map = {}
    group_col_map = {}
    revenue_col = None

    for col_idx, header in enumerate(headers):
        header_clean = header.replace("\n", " ").strip().upper()
        if "REVENUE" in header_clean and "TOTAL" in header_clean:
            revenue_col = col_index_to_letter(col_idx)
            continue
        matched_group = False
        for group_name, group in fb_account_groups.items():
            if group["header_match"].upper() in header_clean:
                group_col_map[group_name] = col_index_to_letter(col_idx)
                matched_group = True
                break
        if matched_group:
            continue
        header_key = extract_account_key(header)
        if header_key:
            for acc_id, acc_name in fb_accounts.items():
                acc_key = extract_account_key(acc_name) or acc_name
                if acc_key.upper().strip() == header_key.upper().strip():
                    col_map[acc_id] = (col_index_to_letter(col_idx), acc_name)
                    break

    date_rows = {}
    for i in range(header_row_idx + 1, len(all_data)):
        date_val = all_data[i][0].strip() if all_data[i] else ""
        if date_val:
            date_rows[date_val] = i + 1

    return header_row_idx + 1, col_map, group_col_map, revenue_col, date_rows


def check_new_tab_reminder(sh, today: datetime, slack_webhook: str):
    last_day = calendar.monthrange(today.year, today.month)[1]
    days_left = last_day - today.day
    if days_left > 4:
        return
    next_month = today.month + 1 if today.month < 12 else 1
    next_year = today.year if today.month < 12 else today.year + 1
    next_tab = f"{MONTH_NAMES[next_month]} {next_year}"
    existing_tabs = [ws.title for ws in sh.worksheets()]
    if next_tab not in existing_tabs:
        if days_left == 0:
            urgency = "🚨 *HOY es el último día*"
        elif days_left == 1:
            urgency = "🚨 *MAÑANA es el último día*"
        else:
            urgency = f"⚠️ *Faltan {days_left} días*"
        _send_slack(slack_webhook,
            f"{urgency} — Crea la pestaña `{next_tab}` en el sheet\n\n"
            f"El tracker la necesita antes del día 1.\n"
            f"Agrega fechas en columna A (formato: M/D/YYYY) y columnas igual al mes actual."
        )


# ─────────────────────────── Intraday ───────────────────────────

def run_intraday(task=None):
    """Fetch spend/revenue del día actual y envía Live Tracker a Slack."""
    log.info("live_tracker: inicio")
    started_at = datetime.now(timezone.utc)

    try:
        raw = cfg_module.load_config()
    except Exception as e:
        log.error("live_tracker: error cargando config: %s", e)
        return

    fb_token_primary = raw.get("fb_token_primary", "")
    fb_tokens = [fb_token_primary] if fb_token_primary else []

    ds24_key = raw.get("ds24_key", "")
    jvzoo_key = raw.get("jvzoo_key", "")
    cb_key = raw.get("cb_key", "")
    slack_webhook = raw.get("slack_webhook_main", "")

    fb_accounts: dict = get_all_accounts(fb_token_primary) if fb_token_primary else {}
    fb_account_groups: dict = json.loads(raw.get("account_groups_json", "{}"))

    if not fb_accounts:
        log.warning("live_tracker: no se encontraron cuentas activas en el token")
        return

    now = datetime.now(COL_TZ)
    date_str = now.strftime("%Y-%m-%d")
    time_label = now.strftime("%I:%M %p")

    group_account_ids = {aid for g in fb_account_groups.values() for aid in g.get("accounts", {}).keys()}
    all_ids = list(set(list(fb_accounts.keys()) + list(group_account_ids)))
    errors = []
    all_data, fb_err = get_fb_spend_batch(all_ids, date_str, fb_tokens)
    if fb_err:
        errors.append(fb_err)

    account_lines = []
    total_spend = 0.0
    for acc_id, acc_name in fb_accounts.items():
        if acc_id in group_account_ids:
            continue
        d = all_data.get(acc_id, {"spend": 0.0, "fb_revenue": 0.0, "fb_purchases": 0})
        spend = d["spend"]
        fb_rev = d["fb_revenue"]
        fb_purchases = d["fb_purchases"]
        total_spend += spend
        if spend > 0:
            fb_profit = fb_rev - spend
            cpa = spend / fb_purchases if fb_purchases > 0 else 0.0
            roi = (fb_profit / spend) * 100
            account_lines.append(
                f"  Account: {acc_name} | Spent: ${spend:,.2f} | Revenue: ${fb_rev:,.2f} | "
                f"Profit: ${fb_profit:,.2f} | ROI: {roi:.1f}% | CPA: ${cpa:,.2f}"
            )

    for group_name, group in fb_account_groups.items():
        g_spend = g_rev = 0.0
        g_lines = []
        for acc_id, acc_name in group.get("accounts", {}).items():
            d = all_data.get(acc_id, {"spend": 0.0, "fb_revenue": 0.0, "fb_purchases": 0})
            spend = d["spend"]
            fb_rev = d["fb_revenue"]
            fb_purchases = d["fb_purchases"]
            g_spend += spend
            g_rev += fb_rev
            if spend > 0:
                fb_profit = fb_rev - spend
                cpa = spend / fb_purchases if fb_purchases > 0 else 0.0
                roi = (fb_profit / spend) * 100
                g_lines.append(
                    f"  Account: {acc_name} | Spent: ${spend:,.2f} | Revenue: ${fb_rev:,.2f} | "
                    f"Profit: ${fb_profit:,.2f} | ROI: {roi:.1f}% | CPA: ${cpa:,.2f}"
                )
        total_spend += g_spend
        account_lines.extend(g_lines)

    ds24_rev, ds24_err = get_ds24_revenue(date_str, ds24_key)
    jvzoo_rev, jvzoo_err = get_jvzoo_revenue(date_str, jvzoo_key)
    cb_rev, cb_err = get_cb_revenue(date_str, cb_key)
    if ds24_err:
        errors.append(ds24_err)
    if jvzoo_err:
        errors.append(jvzoo_err)
    if cb_err:
        errors.append(cb_err)

    total_revenue = ds24_rev + jvzoo_rev + cb_rev
    profit = total_revenue - total_spend
    roi = (profit / total_spend * 100) if total_spend > 0 else 0.0

    status = "🔴" if errors else "🟢"
    accounts_block = "\n".join(account_lines) if account_lines else "  No spend"
    msg = (
        f"{status} *Live Tracker — {date_str} @ {time_label}*\n\n"
        f"💸 *Facebook Accounts:*\n{accounts_block}\n\n"
        f"💸 *Total Spend: ${total_spend:,.2f}*\n\n"
        f"💰 *Revenue: ${total_revenue:,.2f}*\n"
        f"  • DS24: ${ds24_rev:,.2f}\n"
        f"  • JVZoo: ${jvzoo_rev:,.2f}\n"
        f"  • ClickBank: ${cb_rev:,.2f}\n\n"
        f"📊 *Profit: ${profit:,.2f}* | ROI: {roi:.1f}%"
    )
    if errors:
        msg += "\n\n🔴 *Errors:*\n" + "\n".join([f"  • {e}" for e in errors])

    if slack_webhook:
        _send_slack(slack_webhook, msg)

    finished_at = datetime.now(timezone.utc)
    db_module.save_job_run("live_tracker", started_at, finished_at, not bool(errors),
                           {"date": date_str,
                            "total_spend": round(total_spend, 2),
                            "total_revenue": round(total_revenue, 2),
                            "errors": errors})
    log.info("live_tracker done — spend=$%.2f revenue=$%.2f", total_spend, total_revenue)


# ─────────────────────────── Daily ───────────────────────────

def run_daily(task=None):
    """Fetch spend/revenue del día anterior y escribe en Google Sheet."""
    log.info("update_sheet_daily: inicio")
    started_at = datetime.now(timezone.utc)

    try:
        raw = cfg_module.load_config()
    except Exception as e:
        log.error("update_sheet_daily: error cargando config: %s", e)
        return

    fb_token_primary = raw.get("fb_token_primary", "")
    fb_tokens = [fb_token_primary] if fb_token_primary else []

    ds24_key = raw.get("ds24_key", "")
    jvzoo_key = raw.get("jvzoo_key", "")
    cb_key = raw.get("cb_key", "")
    sheet_id = raw.get("spend_sheet_id", "")
    slack_webhook = raw.get("slack_webhook_daily", "") or raw.get("slack_webhook_main", "")

    fb_accounts: dict = get_all_accounts(fb_token_primary) if fb_token_primary else {}
    fb_account_groups: dict = json.loads(raw.get("account_groups_json", "{}"))
    service_account_info: dict = json.loads(raw.get("service_account_json", "{}"))

    if not fb_accounts:
        log.warning("update_sheet_daily: no se encontraron cuentas activas en el token")
        return

    if not service_account_info:
        log.error("update_sheet_daily: service_account_json no configurado")
        return
    if not sheet_id:
        log.error("update_sheet_daily: spend_sheet_id no configurado")
        return

    now = datetime.now(COL_TZ)
    target = now - timedelta(days=1)
    date_str_target = target.strftime("%Y-%m-%d")
    date_sheet = f"{target.month}/{target.day}/{target.year}"
    tab_name = f"{MONTH_NAMES[target.month]} {target.year}"
    errors = []
    warnings = []

    try:
        scopes = ["https://www.googleapis.com/auth/spreadsheets"]
        creds = Credentials.from_service_account_info(service_account_info, scopes=scopes)
        gc = gspread.authorize(creds)
        sh = gc.open_by_key(sheet_id)
    except Exception as e:
        if slack_webhook:
            _send_slack(slack_webhook, f"🔴 *Tracker FAILED* ({date_str_target})\nSheets connection failed:\n`{e}`")
        db_module.save_job_run("update_sheet_daily", started_at, datetime.now(timezone.utc),
                               False, None, str(e))
        return

    check_new_tab_reminder(sh, now, slack_webhook)

    try:
        ws = sh.worksheet(tab_name)
    except gspread.exceptions.WorksheetNotFound:
        msg = (f"🔴 *Tracker FAILED* ({date_str_target})\n"
               f"La pestaña `{tab_name}` no existe en el sheet.")
        if slack_webhook:
            _send_slack(slack_webhook, msg)
        db_module.save_job_run("update_sheet_daily", started_at, datetime.now(timezone.utc),
                               False, None, f"Tab '{tab_name}' not found")
        return

    try:
        _, col_map, group_col_map, revenue_col, date_rows = discover_sheet_layout(ws, fb_accounts, fb_account_groups)
    except Exception as e:
        if slack_webhook:
            _send_slack(slack_webhook, f"🔴 *Tracker FAILED* ({date_str_target})\nCould not read layout:\n`{e}`")
        db_module.save_job_run("update_sheet_daily", started_at, datetime.now(timezone.utc), False, None, str(e))
        return

    group_account_ids = {aid for g in fb_account_groups.values() for aid in g.get("accounts", {}).keys()}
    unmapped = set(fb_accounts.keys()) - set(col_map.keys()) - group_account_ids
    if unmapped:
        warnings.append(f"Accounts not in headers: {', '.join(fb_accounts[a] for a in unmapped)}")

    row = date_rows.get(date_sheet)
    if not row:
        msg = (f"🔴 *Tracker FAILED* ({date_str_target})\n"
               f"Date `{date_sheet}` not found in `{tab_name}`.")
        if slack_webhook:
            _send_slack(slack_webhook, msg)
        db_module.save_job_run("update_sheet_daily", started_at, datetime.now(timezone.utc),
                               False, None, f"Date {date_sheet} not found")
        return

    group_fetch_ids = []
    for gname in group_col_map:
        group_fetch_ids.extend(fb_account_groups[gname].get("accounts", {}).keys())
    accounts_to_fetch = list(set(col_map.keys()) | set(group_fetch_ids))
    all_data, fb_err = get_fb_spend_batch(accounts_to_fetch, date_str_target, fb_tokens)
    if fb_err:
        errors.append(fb_err)

    updates = []
    account_lines = []
    total_spend = 0.0
    spend_by_name = {}

    for acc_id, (col_letter, acc_name) in col_map.items():
        d = all_data.get(acc_id, {"spend": 0.0, "fb_revenue": 0.0, "fb_purchases": 0})
        spend = d["spend"]
        fb_rev = d["fb_revenue"]
        fb_purchases = d["fb_purchases"]
        updates.append({"range": f"{col_letter}{row}", "values": [[spend]]})
        total_spend += spend
        if spend > 0:
            spend_by_name[acc_name] = spend
            fb_profit = fb_rev - spend
            cpa = spend / fb_purchases if fb_purchases > 0 else 0.0
            roi = (fb_profit / spend) * 100
            account_lines.append(
                f"  Account: {acc_name} | Spent: ${spend:,.2f} | Revenue: ${fb_rev:,.2f} | "
                f"Profit: ${fb_profit:,.2f} | ROI: {roi:.1f}% | CPA: ${cpa:,.2f}"
            )

    for gname, col_letter in group_col_map.items():
        group = fb_account_groups[gname]
        g_spend = g_rev = 0.0
        g_lines = []
        for acc_id, acc_name in group.get("accounts", {}).items():
            d = all_data.get(acc_id, {"spend": 0.0, "fb_revenue": 0.0, "fb_purchases": 0})
            spend = d["spend"]
            fb_rev = d["fb_revenue"]
            fb_purchases = d["fb_purchases"]
            g_spend += spend
            g_rev += fb_rev
            if spend > 0:
                fb_profit = fb_rev - spend
                cpa = spend / fb_purchases if fb_purchases > 0 else 0.0
                roi = (fb_profit / spend) * 100
                g_lines.append(
                    f"  Account: {acc_name} | Spent: ${spend:,.2f} | Revenue: ${fb_rev:,.2f} | "
                    f"Profit: ${fb_profit:,.2f} | ROI: {roi:.1f}% | CPA: ${cpa:,.2f}"
                )
        updates.append({"range": f"{col_letter}{row}", "values": [[g_spend]]})
        total_spend += g_spend
        if g_spend > 0:
            spend_by_name[gname] = g_spend
            account_lines.extend(g_lines)

    ds24_rev, ds24_err = get_ds24_revenue(date_str_target, ds24_key)
    jvzoo_rev, jvzoo_err = get_jvzoo_revenue(date_str_target, jvzoo_key)
    cb_rev, cb_err = get_cb_revenue(date_str_target, cb_key)
    if ds24_err:
        errors.append(ds24_err)
    if jvzoo_err:
        errors.append(jvzoo_err)
    if cb_err:
        errors.append(cb_err)

    total_revenue = ds24_rev + jvzoo_rev + cb_rev
    if revenue_col:
        updates.append({"range": f"{revenue_col}{row}", "values": [[total_revenue]]})

    try:
        if updates:
            ws.batch_update(updates, value_input_option="USER_ENTERED")
    except Exception as e:
        if slack_webhook:
            _send_slack(slack_webhook, f"🔴 *Tracker FAILED* ({date_str_target})\nSheet write failed:\n`{e}`")
        db_module.save_job_run("update_sheet_daily", started_at, datetime.now(timezone.utc), False, None, str(e))
        return

    profit = total_revenue - total_spend
    roi = (profit / total_spend * 100) if total_spend > 0 else 0.0
    status = "🔴" if errors else ("🟡" if warnings else "🟢")
    accounts_block = "\n".join(account_lines) if account_lines else "  No spend"
    msg = (
        f"{status} *Daily Tracker — {date_str_target}*\n"
        f"Tab: `{tab_name}` | Row: {row}\n\n"
        f"💸 *Facebook Accounts:*\n{accounts_block}\n\n"
        f"💸 *Total Spend: ${total_spend:,.2f}*\n\n"
        f"💰 *Revenue: ${total_revenue:,.2f}*\n"
        f"  • DS24: ${ds24_rev:,.2f}\n"
        f"  • JVZoo: ${jvzoo_rev:,.2f}\n"
        f"  • ClickBank: ${cb_rev:,.2f}\n\n"
        f"📊 *Profit: ${profit:,.2f}* | ROI: {roi:.1f}%"
    )
    if errors:
        msg += "\n\n🔴 *Errors:*\n" + "\n".join([f"  • {e}" for e in errors])
    if warnings:
        msg += "\n\n⚠️ *Warnings:*\n" + "\n".join([f"  • {w}" for w in warnings])

    if slack_webhook:
        _send_slack(slack_webhook, msg)

    finished_at = datetime.now(timezone.utc)
    db_module.save_job_run("update_sheet_daily", started_at, finished_at, not bool(errors),
                           {"date": date_str_target, "tab": tab_name,
                            "total_spend": round(total_spend, 2),
                            "total_revenue": round(total_revenue, 2),
                            "errors": errors, "warnings": warnings})
    log.info("update_sheet_daily done — spend=$%.2f revenue=$%.2f", total_spend, total_revenue)
