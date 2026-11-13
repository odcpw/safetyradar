#!/usr/bin/env python3
"""Read-only Safety Radar status snapshot. Run on the VPS only; never call Meta from the box."""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
import json
import re
from pathlib import Path
import subprocess
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from meta_common import (
    ACCOUNT_ID,
    CAMPAIGN_ID,
    IG_USER_ID,
    PAGE_ID,
    TOKEN_PATH,
    MetaAPIError,
    MetaClient,
    OperationError,
    append_jsonl,
    classify_meta_health,
    print_result,
    run_cli,
    save_json,
    save_text,
)

ZURICH = ZoneInfo("Europe/Zurich")
DEFAULT_STATS = Path("/srv/safetyradar/stats")
DEFAULT_JOURNAL = Path("/srv/safetyradar/ops/journal.jsonl")
VPS_TOKEN = Path("/srv/safetyradar/.secrets/meta_token")
VPS_APP = Path("/srv/safetyradar/app")
LISTMONK_SQL = (
    "SELECT (SELECT count(*) FROM subscribers) AS total, "
    "(SELECT count(DISTINCT subscriber_id) FROM subscriber_lists "
    "WHERE status = 'confirmed') AS confirmed, "
    "(SELECT count(*) FROM subscribers WHERE created_at >= NOW() - INTERVAL '7 days') "
    "AS created_last_7_days;"
)
INSIGHT_FIELDS = "ad_id,ad_name,campaign_id,campaign_name,spend,impressions,reach,clicks,actions"
CAMPAIGN_INSIGHT_FIELDS = "campaign_id,campaign_name,spend,impressions,reach,clicks,actions"
AD_STATUS_FIELDS = "id,name,status,effective_status,ad_review_feedback,issues_info,creative{id,status}"


def on_vps():
    return VPS_TOKEN.is_file() and VPS_APP.is_dir()


def as_decimal(value, default="0"):
    try:
        return Decimal(str(value if value is not None else default))
    except (InvalidOperation, ValueError):
        return Decimal(default)


def as_int(value, default=0):
    try:
        return int(Decimal(str(value if value not in (None, "") else default)))
    except (InvalidOperation, ValueError, TypeError):
        return default


def link_clicks_of(row):
    clicks = 0
    for item in row.get("actions") or []:
        if isinstance(item, dict) and item.get("action_type") == "link_click":
            clicks += as_int(item.get("value"))
    return clicks


def metric_block(row):
    spend = as_decimal(row.get("spend"))
    impressions = as_int(row.get("impressions"))
    clicks = as_int(row.get("clicks"))
    links = link_clicks_of(row)
    reach = as_int(row.get("reach"))
    return {
        "currency": "CHF",
        "spend": float(spend),
        "impressions": impressions,
        "clicks": clicks,
        "link_clicks": links,
        "reach": reach,
        "cpc": round(float(spend / clicks), 4) if clicks else None,
        "ctr_pct": round(clicks / impressions * 100, 4) if impressions else None,
        "link_cpc": round(float(spend / links), 4) if links else None,
        "link_ctr_pct": round(links / impressions * 100, 4) if impressions else None,
    }


def empty_metrics():
    return metric_block({})


def fmt_pct(value):
    return "—" if value is None else f"{value:.4f}%"


def fmt_money(value):
    return f"{value:.2f}"


def fmt_cpc(value):
    return "—" if value is None else f"{value:.4f}"


def format_metrics(block):
    return (f"spend {fmt_money(block['spend'])}  impressions {block['impressions']}  "
            f"clicks {block['clicks']}  link_clicks {block['link_clicks']}  "
            f"CTR {fmt_pct(block['ctr_pct'])}  CPC {fmt_cpc(block['cpc'])}  "
            f"link_CTR {fmt_pct(block['link_ctr_pct'])}  link_CPC {fmt_cpc(block['link_cpc'])}  "
            f"reach {block['reach'] if block['reach'] is not None else '—'}")


def insight_query(level, fields, window):
    query = {"level": level, "fields": fields,
             "filtering": [{"field": "campaign.id", "operator": "IN", "value": [CAMPAIGN_ID]}]}
    query.update(window["params"])
    return query


def summarise_review(feedback, issues):
    parts = []
    if feedback:
        if isinstance(feedback, dict):
            keys = [key for key, value in feedback.items() if value]
            parts.append(", ".join(keys) if keys else "none")
        else:
            parts.append(str(feedback)[:200])
    else:
        parts.append("none")
    if issues:
        if isinstance(issues, list):
            labels = []
            for item in issues:
                if isinstance(item, dict):
                    labels.append(str(item.get("error_message") or item.get("level") or item)[:160])
                else:
                    labels.append(str(item)[:160])
            parts.append("; ".join(labels) if labels else "none")
        else:
            parts.append(str(issues)[:200])
    else:
        parts.append("none")
    return {"ad_review_feedback": parts[0], "issues_info": parts[1]}


def listmonk_counts():
    try:
        result = subprocess.run(
            ["/usr/bin/docker", "exec", "listmonk_db", "psql", "-U", "listmonk", "-d", "listmonk",
             "-t", "-A", "-F", ",", "-c", LISTMONK_SQL],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise OperationError(f"Listmonk count command failed ({type(exc).__name__}).") from None
    if result.returncode != 0:
        raise OperationError("Listmonk count command exited non-zero.")
    line = (result.stdout or "").strip().splitlines()
    if not line:
        raise OperationError("Listmonk count command returned no rows.")
    parts = line[0].split(",")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        raise OperationError("Listmonk count command returned an unexpected shape.")
    return {"total": int(parts[0]), "confirmed": int(parts[1]), "created_last_7_days": int(parts[2])}


def load_analytics(stats_dir):
    stats_dir = Path(stats_dir)
    payload_path = stats_dir / "analytics-latest.json"
    text_path = stats_dir / "analytics-latest.txt"
    data = None
    if payload_path.is_file():
        try:
            loaded = json.loads(payload_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, ValueError, UnicodeError):
            data = None
    text = None
    if text_path.is_file():
        try:
            text = text_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            text = None
    if data is None and text is None:
        return {"available": False, "error": "analytics-latest.json and .txt are missing."}
    campaigns = []
    if isinstance(data, dict):
        for row in data.get("byCampaign") or []:
            if not isinstance(row, dict):
                continue
            campaigns.append({
                "source": row.get("source"),
                "medium": row.get("medium"),
                "campaign": row.get("campaign"),
                "variant": row.get("variant"),
                "pageviews": as_int(row.get("pageviews")),
                "signupSubmissions": as_int(row.get("signupSubmissions")),
                "signupAcceptedResponses": as_int(row.get("signupAcceptedResponses")),
                "signupConfirmedResponses": as_int(row.get("signupConfirmedResponses")),
            })
        metrics = data.get("metrics") if isinstance(data.get("metrics"), dict) else {}
        summary = {
            "available": True,
            "from": data.get("from"),
            "through": data.get("through"),
            "metrics": {
                key: as_int(metrics.get(key))
                for key in ("pageviews", "signupSubmissions", "signupAcceptedResponses",
                            "signupConfirmedResponses", "engagementSamples", "activeSeconds")
                if key in metrics or True
            },
            "byCampaign": campaigns,
            "source_files": [str(payload_path), str(text_path)],
        }
    else:
        summary = {"available": True, "source_files": [str(text_path)], "byCampaign": [], "metrics": {}}
    summary["text"] = text
    return summary


RETARGET_DAY = date(2026, 11, 10)
PAGE_INSIGHT_METRICS = (
    "page_views_total",
    "page_media_view",
    "page_total_media_view_unique",
    "page_post_engagements",
    "page_follows",
    "page_daily_follows",
)
PAGE_INSIGHT_LABELS = {
    "page_views_total": "page views",
    "page_media_view": "media views",
    "page_total_media_view_unique": "unique media views",
    "page_post_engagements": "post engagements",
    "page_follows": "follows",
    "page_daily_follows": "daily follows",
    "page_impressions": "impressions",
    "page_impressions_unique": "unique impressions",
}
PAGE_ANALYTIC_FIELDS = (
    "pageviews", "engagementSamples", "activeSeconds", "depth25", "depth50",
    "depth75", "depth100", "signupSubmissions", "signupAcceptedResponses",
    "signupConfirmedResponses",
)


def parse_meta_datetime(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if re.search(r"[+-]\d{4}$", text):
        text = text[:-2] + ":" + text[-2:]
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo("UTC"))
    return parsed.astimezone(ZURICH)


def format_zurich(value):
    parsed = parse_meta_datetime(value) if not isinstance(value, datetime) else value.astimezone(ZURICH)
    if parsed is None:
        return value or "—"
    return parsed.strftime("%Y-%m-%d %H:%M ") + "Europe/Zurich"


def insight_day(end_time):
    parsed = parse_meta_datetime(end_time)
    if parsed is None:
        return None
    # Page insights end_time is an exclusive period end, usually midnight
    # Pacific or the Page timezone. One second earlier in Pacific yields the
    # included calendar day for both Pacific and Europe/Zurich midnights.
    local = parsed.astimezone(ZoneInfo("America/Los_Angeles"))
    return (local - timedelta(seconds=1)).date().isoformat()


def metric_number(value):
    if value is None:
        return None
    if isinstance(value, dict):
        if "total" in value:
            return as_int(value.get("total"), default=None)
        total = 0
        found = False
        for item in value.values():
            if isinstance(item, (int, float, str, Decimal)):
                total += as_int(item)
                found = True
        return total if found else None
    return as_int(value, default=None)


def page_token_required(exc):
    if not isinstance(exc, MetaAPIError) or exc.code != 190:
        return False
    return bool(re.search(r"page access token", exc.api_message or "", re.I))


def optional_meta_failure(exc):
    if not isinstance(exc, MetaAPIError):
        return False
    if page_token_required(exc):
        return True
    health = classify_meta_health(exc)
    if health in {"BLOCKED", "TOKEN"}:
        return False
    return health == "PERMISSION" or exc.code in (10, 100, 200, 803)


def invalid_metric_name(exc):
    message = (exc.api_message or "") if isinstance(exc, MetaAPIError) else ""
    match = re.search(r"(page_[a-z0-9_]+)", message, re.I)
    return match.group(1) if match else None


def resolve_page(collector):
    notes = []
    try:
        result = collector.get("me/accounts", {"fields": "id,name,fan_count,followers_count"})
        rows = result.get("data") if isinstance(result, dict) else None
        if rows:
            chosen = next((row for row in rows if str(row.get("id")) == PAGE_ID), rows[0])
            if chosen.get("id"):
                return str(chosen["id"]), "me/accounts", notes
        notes.append("/me/accounts returned no Pages.")
    except MetaAPIError as exc:
        if not optional_meta_failure(exc):
            raise
        notes.append(f"/me/accounts unavailable (code {exc.code}).")
    try:
        ads = collector.get(f"act_{ACCOUNT_ID}/ads", {
            "fields": "creative{object_story_spec}",
            "filtering": [{"field": "campaign.id", "operator": "IN", "value": [CAMPAIGN_ID]}],
            "limit": 1,
        })
        data = ads.get("data") if isinstance(ads, dict) else None
        if data:
            spec = ((data[0].get("creative") or {}).get("object_story_spec") or {})
            page_id = spec.get("page_id")
            if page_id:
                return str(page_id), "ad creative object_story_spec", notes
        notes.append("No page id was present on the first ad creative.")
    except MetaAPIError as exc:
        if not optional_meta_failure(exc):
            raise
        notes.append(f"Ad creative page id unavailable (code {exc.code}).")
    notes.append(f"Using configured PAGE_ID {PAGE_ID}.")
    return PAGE_ID, "configured PAGE_ID", notes


def fetch_page_insights(collector, page_id, since, until, remaining):
    notes = []
    rows = []
    pending = list(remaining)
    while pending:
        try:
            result = collector.get(f"{page_id}/insights", {
                "metric": ",".join(pending),
                "period": "day",
                "since": since,
                "until": until,
            })
            data = result.get("data") if isinstance(result, dict) else None
            if isinstance(data, list):
                rows.extend(data)
            return rows, notes, [row.get("name") for row in rows if isinstance(row, dict)]
        except MetaAPIError as exc:
            if page_token_required(exc):
                notes.append("Page insights need a Page access token. /me/accounts returned no Pages, so the user token cannot read them.")
                return rows, notes, [row.get("name") for row in rows if isinstance(row, dict)]
            if not optional_meta_failure(exc) and exc.code not in (100, 10):
                raise
            name = invalid_metric_name(exc)
            if name and name in pending:
                pending.remove(name)
                notes.append(f"{name} unavailable ({exc.api_message or f'code {exc.code}'}).")
                continue
            if len(pending) == 1:
                notes.append(
                    f"Page insights metric {pending[0]} unavailable "
                    f"({exc.api_message or f'code {exc.code}'})."
                )
                return rows, notes, []
            # Could not tell which metric failed; try one at a time.
            individual = []
            for metric in list(pending):
                part, part_notes, ok = fetch_page_insights(collector, page_id, since, until, [metric])
                rows.extend(part)
                notes.extend(part_notes)
                individual.extend(ok)
                pending = [item for item in pending if item != metric]
            return rows, notes, individual
    return rows, notes, []


def collect_window_values(series, today):
    yesterday = (today - timedelta(days=1)).isoformat()
    last_7_start = (today - timedelta(days=6)).isoformat()
    last_28_start = (today - timedelta(days=27)).isoformat()
    today_s = today.isoformat()

    def total(start, end):
        values = [value for day, value in series if value is not None and start <= day <= end]
        return sum(values) if values else None

    return {
        "today": total(today_s, today_s),
        "yesterday": total(yesterday, yesterday),
        "last_7": total(last_7_start, today_s),
        "last_28": total(last_28_start, today_s),
    }


def collect_page(collector, today):
    notes = []
    page_id, resolved_from, resolve_notes = resolve_page(collector)
    notes.extend(resolve_notes)
    profile = {"id": page_id}
    try:
        profile = collector.get(page_id, {"fields": "id,name,fan_count,followers_count"})
    except MetaAPIError as exc:
        if not optional_meta_failure(exc):
            raise
        if page_token_required(exc):
            notes.append("Page profile and insights need a Page access token. /me/accounts returned no Pages, so the user token cannot read them.")
        else:
            notes.append(f"Page profile unavailable (code {exc.code}).")
    until = (today + timedelta(days=1)).isoformat()
    since = (today - timedelta(days=27)).isoformat()
    rows, insight_notes, available = fetch_page_insights(
        collector, page_id, since, until, list(PAGE_INSIGHT_METRICS),
    )
    notes.extend(insight_notes)
    if not available and not insight_notes:
        notes.append("No Page insights rows were returned.")
    metrics = {}
    for row in rows:
        if not isinstance(row, dict) or not row.get("name"):
            continue
        series = []
        for item in row.get("values") or []:
            if not isinstance(item, dict):
                continue
            day = insight_day(item.get("end_time"))
            if not day:
                continue
            series.append((day, metric_number(item.get("value"))))
        metrics[row["name"]] = collect_window_values(series, today)
    missing = [name for name in PAGE_INSIGHT_METRICS if name not in metrics]
    if missing and available:
        notes.append("No data returned for: " + ", ".join(missing) + ".")
    return {
        "available": True,
        "id": str(profile.get("id") or page_id),
        "name": profile.get("name"),
        "resolved_from": resolved_from,
        "fan_count": profile.get("fan_count"),
        "followers": profile.get("followers_count") if profile.get("followers_count") is not None else profile.get("fan_count"),
        "metrics": metrics,
        "windows": {
            "today": today.isoformat(),
            "yesterday": (today - timedelta(days=1)).isoformat(),
            "last_7_since": (today - timedelta(days=6)).isoformat(),
            "last_28_since": (today - timedelta(days=27)).isoformat(),
        },
        "notes": notes,
    }


def cohort_label(row):
    source = row.get("source") or "unattributed"
    variant = row.get("variant")
    campaign = row.get("campaign")
    if source in ("fb", "ig") and variant in ("a", "b", "c"):
        return f"{source} {variant}"
    if source in ("unattributed", "none", "", None) and campaign in ("none", "", None):
        return "unattributed"
    parts = [str(source)]
    if campaign not in ("none", "", None):
        parts.append(str(campaign))
    if variant not in ("none", "", None):
        parts.append(str(variant))
    return " ".join(parts)


def empty_page_row():
    return {key: 0 for key in PAGE_ANALYTIC_FIELDS}


def add_page_row(target, row):
    for key in PAGE_ANALYTIC_FIELDS:
        target[key] += as_int(row.get(key))
    return target


def summarise_page_row(row):
    samples = as_int(row.get("engagementSamples"))
    active = as_int(row.get("activeSeconds"))
    views = as_int(row.get("pageviews"))
    depth50 = as_int(row.get("depth50"))
    depth100 = as_int(row.get("depth100"))
    return {
        "pageviews": views,
        "active_seconds": active,
        "engagement_samples": samples,
        "avg_active_seconds": round(active / samples, 1) if samples else None,
        "depth50": depth50,
        "depth100": depth100,
        "depth50_pct": round(depth50 / samples * 100, 1) if samples else None,
        "depth100_pct": round(depth100 / samples * 100, 1) if samples else None,
        "signup_submissions": as_int(row.get("signupSubmissions")),
    }


def read_event_days(events_dir):
    events_dir = Path(events_dir)
    days = {}
    if not events_dir.is_dir():
        return days
    for path in events_dir.iterdir():
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.json", path.name):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError):
            continue
        rows = data.get("rows") if isinstance(data, dict) else None
        if not isinstance(rows, dict):
            continue
        days[path.name[:10]] = [row for row in rows.values() if isinstance(row, dict)]
    return days


def select_days(days, today, kind):
    keys = sorted(days)
    today_s = today.isoformat()
    if kind == "today":
        chosen = [today_s] if today_s in days else []
        return chosen, today_s, today_s
    if kind == "last_7":
        start = (today - timedelta(days=6)).isoformat()
        chosen = [key for key in keys if start <= key <= today_s]
        return chosen, start, today_s
    if kind == "since_retarget":
        start = RETARGET_DAY.isoformat()
        chosen = [key for key in keys if key >= start and key <= today_s]
        return chosen, start, today_s
    chosen = keys
    return chosen, keys[0] if keys else None, keys[-1] if keys else None


def aggregate_pages(day_map, chosen):
    pages = {}
    for day in chosen:
        for row in day_map.get(day, []):
            page = row.get("page") or "(unknown)"
            bucket = pages.setdefault(page, {"total": empty_page_row(), "cohorts": {}})
            add_page_row(bucket["total"], row)
            label = cohort_label(row)
            add_page_row(bucket["cohorts"].setdefault(label, empty_page_row()), row)
    result = []
    for page, bucket in pages.items():
        entry = {"page": page, **summarise_page_row(bucket["total"]), "cohorts": []}
        for label, row in bucket["cohorts"].items():
            entry["cohorts"].append({"cohort": label, **summarise_page_row(row)})
        paid_order = {"fb a": 0, "fb b": 1, "fb c": 2, "ig a": 3, "ig b": 4, "ig c": 5, "unattributed": 6}
        entry["cohorts"].sort(key=lambda item: (paid_order.get(item["cohort"], 50), item["cohort"]))
        result.append(entry)
    result.sort(key=lambda item: (-item["pageviews"], item["page"]))
    return result


def build_page_analytics(events_dir, today):
    days = read_event_days(events_dir)
    if not days:
        return {"available": False, "error": "No retained cookieless event files were found.",
                "events_dir": str(events_dir)}
    windows = {}
    for kind, title in (("today", "Today"), ("last_7", "Last 7 days"), ("all_time", "All-time")):
        chosen, start, until = select_days(days, today, kind)
        windows[kind] = {
            "title": title,
            "since": start,
            "until": until,
            "day_count": len(chosen),
            "pages": aggregate_pages(days, chosen),
        }
    chosen, start, until = select_days(days, today, "since_retarget")
    homepage = next((page for page in aggregate_pages(days, chosen) if page["page"] == "/de/"), None)
    if homepage is None:
        homepage = {"page": "/de/", **summarise_page_row(empty_page_row()), "cohorts": []}
    return {
        "available": True,
        "events_dir": str(events_dir),
        "retained_days": len(days),
        "retained_from": sorted(days)[0],
        "retained_through": sorted(days)[-1],
        "windows": windows,
        "homepage_since_retarget": {
            "since": start,
            "until": until,
            "day_count": len(chosen),
            "page": homepage,
            "note": ("Daily counters for 2026-11-10 include the whole Europe/Zurich day; "
                     "traffic before the homepage retarget at about 06:55 Europe/Zurich cannot be split out."),
        },
    }


def fmt_depth(count, pct):
    if pct is None:
        return f"{count} (—)"
    return f"{count} ({pct:.1f}%)"


def format_page_metric_line(prefix, row):
    avg = "—" if row.get("avg_active_seconds") is None else f"{row['avg_active_seconds']:.1f}s"
    return (f"{prefix}views {row['pageviews']}  active {row['active_seconds']}s  avg {avg}  "
            f"d50 {fmt_depth(row['depth50'], row.get('depth50_pct'))}  "
            f"d100 {fmt_depth(row['depth100'], row.get('depth100_pct'))}  "
            f"signups {row['signup_submissions']}")


def health_record(exc, *, generated_at):
    health = classify_meta_health(exc) or "ERROR"
    return {
        "health": health,
        "code": exc.code if isinstance(exc, MetaAPIError) else None,
        "status": exc.status if isinstance(exc, MetaAPIError) else None,
        "message": (exc.api_message if isinstance(exc, MetaAPIError) else None) or str(exc),
        "fbtrace_id": exc.fbtrace_id if isinstance(exc, MetaAPIError) else None,
        "generated_at": generated_at,
    }


class SnapshotCollector:
    def __init__(self, client):
        self.client = client
        self.calls = 0

    def get(self, path, params=None):
        self.calls += 1
        return self.client.get(path, params)

    def pages(self, path, params=None, *, max_pages=20):
        self.calls += 1
        # Count the first request; further pages increment below by wrapping.
        first = True
        for row in self.client.pages(path, params, max_pages=max_pages):
            if not first:
                self.calls += 1
            first = False
            yield row


def collect_ads(collector, windows):
    account = collector.get(f"act_{ACCOUNT_ID}", {"fields": "currency,timezone_name"})
    if account.get("currency") != "CHF":
        raise OperationError("Account currency is not CHF; refusing to label or convert the report.")
    campaign = collector.get(CAMPAIGN_ID, {
        "fields": "id,name,status,effective_status,objective,start_time,created_time",
    })
    ads = []
    for row in collector.pages(f"act_{ACCOUNT_ID}/ads", {
        "fields": AD_STATUS_FIELDS,
        "filtering": [{"field": "campaign.id", "operator": "IN", "value": [CAMPAIGN_ID]}],
        "limit": 100,
    }):
        creative = row.get("creative") if isinstance(row.get("creative"), dict) else {}
        review = summarise_review(row.get("ad_review_feedback"), row.get("issues_info"))
        ads.append({
            "ad_id": str(row.get("id", "")),
            "ad_name": row.get("name") or "",
            "status": row.get("status"),
            "effective_status": row.get("effective_status"),
            "creative_id": creative.get("id"),
            "creative_status": creative.get("status"),
            **review,
        })
    periods = {}
    for key, window in windows.items():
        ad_rows = list(collector.pages(f"act_{ACCOUNT_ID}/insights", insight_query("ad", INSIGHT_FIELDS, window)))
        campaign_rows = list(collector.pages(
            f"act_{ACCOUNT_ID}/insights", insight_query("campaign", CAMPAIGN_INSIGHT_FIELDS, window),
        ))
        by_ad = {str(row.get("ad_id", "")): metric_block(row) for row in ad_rows}
        if len(campaign_rows) == 1:
            campaign_metrics = metric_block(campaign_rows[0])
        elif not campaign_rows:
            campaign_metrics = empty_metrics()
            # Campaign totals can still be summed from ads except reach.
            spend = sum(Decimal(str(block["spend"])) for block in by_ad.values()) if by_ad else Decimal("0")
            impressions = sum(block["impressions"] for block in by_ad.values())
            clicks = sum(block["clicks"] for block in by_ad.values())
            links = sum(block["link_clicks"] for block in by_ad.values())
            campaign_metrics = metric_block({
                "spend": spend, "impressions": impressions, "clicks": clicks,
                "actions": [{"action_type": "link_click", "value": links}],
                "reach": 0,
            })
            campaign_metrics["reach"] = None
            campaign_metrics["reach_note"] = "Campaign reach unavailable; per-ad reach is not summed."
        else:
            raise OperationError("Campaign insights returned more than one row for a single window.")
        periods[key] = {
            "since": window["since"],
            "until": window["until"],
            "campaign": campaign_metrics,
            "ads": [{**ad, **by_ad.get(ad["ad_id"], empty_metrics())} for ad in ads],
        }
    return {
        "account_timezone": account.get("timezone_name"),
        "currency": "CHF",
        "campaign": {
            "id": str(campaign.get("id") or CAMPAIGN_ID),
            "name": campaign.get("name"),
            "status": campaign.get("status"),
            "effective_status": campaign.get("effective_status"),
            "objective": campaign.get("objective"),
            "start_time": campaign.get("start_time") or campaign.get("created_time"),
        },
        "periods": periods,
    }


def insight_value(data, name):
    if not isinstance(data, list):
        return None
    for row in data:
        if isinstance(row, dict) and row.get("name") == name:
            values = row.get("values") or []
            if values and isinstance(values[0], dict) and "value" in values[0]:
                return as_int(values[0]["value"], default=None) if values[0]["value"] is not None else None
    return None


def collect_instagram(collector):
    notes = []
    profile = {}
    try:
        profile = collector.get(IG_USER_ID, {"fields": "username,followers_count,media_count"})
    except MetaAPIError as exc:
        if classify_meta_health(exc) == "PERMISSION":
            notes.append("followers_count unavailable (permission).")
            profile = collector.get(IG_USER_ID, {"fields": "username,media_count"})
        else:
            raise
    media_rows = collector.get(f"{IG_USER_ID}/media", {
        "fields": "id,caption,timestamp,permalink,media_type,like_count,comments_count",
        "limit": 5,
    })
    media = []
    insights_ok = True
    for row in (media_rows.get("data") or [])[:5]:
        if not isinstance(row, dict):
            continue
        item = {
            "id": row.get("id"),
            "timestamp": row.get("timestamp"),
            "timestamp_zurich": format_zurich(row.get("timestamp")) if row.get("timestamp") else None,
            "permalink": row.get("permalink"),
            "media_type": row.get("media_type"),
            "like_count": as_int(row.get("like_count"), default=None) if row.get("like_count") is not None else None,
            "plays": None,
            "reach": None,
            "likes": None,
        }
        if insights_ok and row.get("id"):
            try:
                insights = collector.get(f"{row['id']}/insights", {"metric": "plays,reach,likes"})
                item["plays"] = insight_value(insights.get("data"), "plays")
                item["reach"] = insight_value(insights.get("data"), "reach")
                item["likes"] = insight_value(insights.get("data"), "likes")
            except MetaAPIError as exc:
                if classify_meta_health(exc) in {"PERMISSION", None} or exc.code in (10, 100, 200):
                    insights_ok = False
                    notes.append(
                        "Media insights skipped"
                        + (f" (code {exc.code})" if exc.code is not None else "")
                        + "."
                    )
                else:
                    raise
        media.append(item)
    return {
        "id": IG_USER_ID,
        "username": profile.get("username") or "safetyradarch",
        "followers": profile.get("followers_count"),
        "media_count": profile.get("media_count"),
        "recent_media": media,
        "notes": notes,
    }


def format_status_text(snapshot):
    health = snapshot["meta_api_health"]
    lines = [
        "Safety Radar status snapshot",
        f"generated_at: {snapshot['generated_at']}",
        f"generated_on: {snapshot.get('generated_on', 'unknown')}",
        f"meta_api_health: {health}",
    ]
    meta_error = snapshot.get("meta_api_error")
    if meta_error:
        lines.append(f"meta_api_error: {meta_error.get('message') or 'unknown'}")
        if meta_error.get("code") is not None:
            lines.append(f"meta_api_code: {meta_error['code']}")
        if meta_error.get("fbtrace_id"):
            lines.append(f"fbtrace_id: {meta_error['fbtrace_id']}")
    lines.append("")

    ads = snapshot.get("ads")
    lines.append("== Ads (CHF) ==")
    if not ads:
        reason = "unavailable"
        if health != "OK":
            reason = f"unavailable because Meta API is {health}"
        lines.extend([reason, ""])
    else:
        campaign = ads["campaign"]
        lines.append(f"Campaign {campaign['id']} {campaign.get('name') or ''}".rstrip())
        lines.append(f"status: {campaign.get('status')}  effective_status: {campaign.get('effective_status')}")
        if ads.get("account_timezone"):
            lines.append(f"account_timezone: {ads['account_timezone']}")
        lines.append("")
        for key, title in (("today", "Today"), ("yesterday", "Yesterday"), ("lifetime", "Lifetime")):
            period = ads["periods"][key]
            if key == "lifetime":
                lines.append(f"Lifetime through {period['until']}")
            else:
                lines.append(f"{title} {period['since']} through {period['until']}")
            campaign_block = period["campaign"]
            extra = ""
            if campaign_block.get("reach") is None:
                extra = "  (campaign reach not summed from ads)"
            lines.append("  campaign: " + format_metrics(campaign_block) + extra)
            for ad in period["ads"]:
                label = f"{ad.get('ad_name') or 'ad'} {ad['ad_id']}"
                lines.append(f"  {label}: {format_metrics(ad)}")
            lines.append("")
        lines.append("Ad review:")
        # Review/status is window-independent; use today (same ad list).
        for ad in ads["periods"]["today"]["ads"]:
            lines.append(
                f"  {ad.get('ad_name') or 'ad'} {ad['ad_id']}: "
                f"status={ad.get('status')} effective_status={ad.get('effective_status')} "
                f"creative={ad.get('creative_status') or '—'} "
                f"review={ad.get('ad_review_feedback') or 'none'} "
                f"issues={ad.get('issues_info') or 'none'}"
            )
        lines.append("")

    ig = snapshot.get("instagram")
    lines.append("== Instagram @safetyradarch (17841441257076577) ==")
    if not ig:
        reason = "unavailable"
        if health != "OK":
            reason = f"unavailable because Meta API is {health}"
        lines.extend([reason, ""])
    else:
        followers = ig.get("followers")
        lines.append(f"username: {ig.get('username') or 'safetyradarch'}")
        lines.append(f"followers: {followers if followers is not None else 'unavailable'}")
        if ig.get("media_count") is not None:
            lines.append(f"media_count: {ig['media_count']}")
        lines.append("last 5:")
        if not ig.get("recent_media"):
            lines.append("  (none)")
        for item in ig.get("recent_media") or []:
            likes = item.get("likes") if item.get("likes") is not None else item.get("like_count")
            lines.append(
                f"  {item.get('timestamp_zurich') or format_zurich(item.get('timestamp'))} {item.get('permalink') or '—'}  "
                f"plays={item.get('plays') if item.get('plays') is not None else '—'} "
                f"reach={item.get('reach') if item.get('reach') is not None else '—'} "
                f"likes={likes if likes is not None else '—'}"
            )
        for note in ig.get("notes") or []:
            lines.append(f"  note: {note}")
        lines.append("")

    page = snapshot.get("page")
    lines.append("== Facebook Page ==")
    if not page:
        reason = "unavailable"
        if health != "OK":
            reason = f"unavailable because Meta API is {health}"
        lines.extend([reason, ""])
    else:
        lines.append(f"Page {page.get('id')} {page.get('name') or ''}".rstrip())
        if page.get("resolved_from"):
            lines.append(f"resolved_from: {page['resolved_from']}")
        fans = page.get("followers")
        fan_count = page.get("fan_count")
        if fans is not None and fan_count is not None and fans != fan_count:
            lines.append(f"followers: {fans}  fan_count: {fan_count}")
        elif fans is not None:
            lines.append(f"followers/fan_count: {fans}")
        elif fan_count is not None:
            lines.append(f"followers/fan_count: {fan_count}")
        else:
            lines.append("followers/fan_count: unavailable")
        windows = page.get("windows") or {}
        labels = (("today", "Today", windows.get("today")),
                  ("yesterday", "Yesterday", windows.get("yesterday")),
                  ("last_7", "Last 7 days", f"{windows.get('last_7_since')} through {windows.get('today')}"),
                  ("last_28", "Last 28 days", f"{windows.get('last_28_since')} through {windows.get('today')}"))
        metrics = page.get("metrics") or {}
        if metrics:
            for key, title, span in labels:
                lines.append(f"{title} {span or ''}".rstrip())
                for name, label in PAGE_INSIGHT_LABELS.items():
                    if name not in metrics:
                        continue
                    value = metrics[name].get(key)
                    shown = "—" if value is None else value
                    lines.append(f"  {label} ({name}): {shown}")
        else:
            lines.append("Page insights metrics unavailable.")
        for note in page.get("notes") or []:
            lines.append(f"  note: {note}")
        lines.append("")

    analytics = snapshot.get("analytics") or {}
    pages = snapshot.get("page_analytics") or {}
    lines.append("== Website page analytics ==")
    if pages.get("available"):
        lines.append(
            "Windows are Europe/Zurich days from cookieless event files. "
            f"All-time covers {pages.get('retained_days', 0)} retained days"
            + (f" ({pages.get('retained_from')} through {pages.get('retained_through')})"
               if pages.get("retained_from") else "")
            + ". The collector keeps 56 days. Test files are excluded."
        )
        lines.append("avg is active seconds / engagement samples. d50/d100 are scroll-depth counts and % of engagement samples.")
        lines.append("")
        for kind in ("today", "last_7", "all_time"):
            window = pages["windows"][kind]
            if kind == "today":
                lines.append(f"{window['title']} {window.get('until') or window.get('since') or '—'}")
            else:
                lines.append(f"{window['title']} {window.get('since') or '—'} through {window.get('until') or '—'}")
            if not window["pages"]:
                lines.append("  (no observed pages)")
            for row in window["pages"]:
                lines.append(format_page_metric_line(f"  {row['page']}: ", row))
                if row["page"] == "/de/" or len(row.get("cohorts") or []) > 1:
                    for cohort in row["cohorts"]:
                        lines.append(format_page_metric_line(f"    {cohort['cohort']}: ", cohort))
            lines.append("")
        home = pages.get("homepage_since_retarget") or {}
        lines.append("Homepage /de/ since retarget 2026-11-10 ~06:55 Europe/Zurich")
        if home.get("note"):
            lines.append(f"  {home['note']}")
        page = home.get("page") or {"pageviews": 0, "active_seconds": 0, "avg_active_seconds": None,
                                    "depth50": 0, "depth100": 0, "depth50_pct": None, "depth100_pct": None,
                                    "signup_submissions": 0, "cohorts": []}
        lines.append(format_page_metric_line("  total: ", page))
        wanted = ["fb a", "fb b", "fb c", "ig a", "ig b", "ig c", "unattributed"]
        present = {item["cohort"]: item for item in page.get("cohorts") or []}
        for label in wanted:
            if label in present:
                lines.append(format_page_metric_line(f"  {label}: ", present[label]))
            else:
                lines.append(f"  {label}: views 0  active 0s  avg —  d50 0 (—)  d100 0 (—)  signups 0")
        for item in page.get("cohorts") or []:
            if item["cohort"] not in wanted:
                lines.append(format_page_metric_line(f"  {item['cohort']}: ", item))
        lines.append("")
        lines.append("Browser observations, not unique people, sessions or Meta clicks. JS/bot blockers and early exits cause losses.")
        lines.append("Active visible time stops after 60 seconds idle and is sampled once at first hide/leave; rounded to 5 seconds, capped at 30 minutes. Scroll depth is viewport reach, not proof of reading.")
        lines.append("Submissions are a separate funnel stage from accepted or confirmed responses and are not ad-attributed people.")
    elif analytics.get("text"):
        lines.append(analytics["text"].rstrip())
    elif analytics.get("available"):
        metrics = analytics.get("metrics") or {}
        lines.append(
            f"pageviews {metrics.get('pageviews', 0)}  "
            f"signupSubmissions {metrics.get('signupSubmissions', 0)}"
        )
    else:
        lines.append(pages.get("error") or analytics.get("error") or "unavailable")
    lines.append("")

    lines.extend(format_capi_lines(snapshot.get("capi")))
    lines.append("")

    listmonk = snapshot.get("listmonk") or {}
    lines.append("== Listmonk ==")
    if listmonk.get("available"):
        lines.append(f"total: {listmonk['total']}")
        lines.append(f"confirmed: {listmonk['confirmed']}")
        lines.append(f"created_last_7_days: {listmonk['created_last_7_days']}")
    else:
        lines.append(listmonk.get("error") or "unavailable")
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def windows_for(today: date):
    yesterday = today - timedelta(days=1)
    return {
        "today": {"since": today.isoformat(), "until": today.isoformat(),
                  "params": {"time_range": {"since": today.isoformat(), "until": today.isoformat()}}},
        "yesterday": {"since": yesterday.isoformat(), "until": yesterday.isoformat(),
                      "params": {"time_range": {"since": yesterday.isoformat(), "until": yesterday.isoformat()}}},
        "lifetime": {"since": "lifetime", "until": today.isoformat(),
                     "params": {"date_preset": "maximum"}},
    }


def build_snapshot(client, *, now, stats_dir, listmonk_fn, generated_on):
    generated_at = now.isoformat()
    today = now.date() if isinstance(now, datetime) else now
    snapshot = {
        "generated_at": generated_at,
        "generated_on": generated_on,
        "meta_api_health": "OK",
        "meta_api_error": None,
        "read_only": True,
        "currency": "CHF",
    }
    collector = SnapshotCollector(client)
    snapshot["ads"] = None
    snapshot["instagram"] = None
    snapshot["page"] = None
    try:
        snapshot["ads"] = collect_ads(collector, windows_for(today))
        snapshot["instagram"] = collect_instagram(collector)
        snapshot["page"] = collect_page(collector, today)
    except MetaAPIError as exc:
        # One attempt: a blocked/token/permission (or other) Meta error stops further Meta calls.
        info = health_record(exc, generated_at=generated_at)
        snapshot["meta_api_health"] = info["health"]
        snapshot["meta_api_error"] = {
            "message": info["message"],
            "code": info["code"],
            "status": info["status"],
            "fbtrace_id": info["fbtrace_id"],
        }
    snapshot["meta_calls"] = collector.calls

    snapshot["analytics"] = load_analytics(stats_dir)
    events_dir = Path(stats_dir) / "events"
    snapshot["page_analytics"] = build_page_analytics(events_dir, today)
    snapshot["capi"] = load_capi(Path(stats_dir) / "capi", today)
    try:
        counts = listmonk_fn()
        snapshot["listmonk"] = {"available": True, **counts}
    except OperationError as exc:
        snapshot["listmonk"] = {"available": False, "error": str(exc)}
    return snapshot


CAPI_EVENTS = ("EngagedVisit", "Lead")


def load_capi(capi_dir, today):
    """Server-side Meta CAPI counters written by the measurement service (no fbc, IP or UA)."""
    capi_dir = Path(capi_dir)
    result = {"available": capi_dir.is_dir(), "today": {}, "last_7_days": {}, "test_today": {},
              "errors_7_days": 0, "last_error": None, "errors": []}
    zero = lambda: {name: 0 for name in CAPI_EVENTS}
    result["today"] = {"sent": zero(), "failed": zero()}
    result["last_7_days"] = {"sent": zero(), "failed": zero()}
    result["test_today"] = zero()
    if not capi_dir.is_dir():
        return result
    start = today - timedelta(days=6)
    for path in sorted(capi_dir.glob("????-??-??.json")):
        try:
            day_value = date.fromisoformat(path.stem)
            data = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError, UnicodeError):
            continue
        if not isinstance(data, dict) or day_value < start or day_value > today:
            continue
        for bucket in ("sent", "failed"):
            counts = data.get(bucket) if isinstance(data.get(bucket), dict) else {}
            for name in CAPI_EVENTS:
                value = as_int(counts.get(name))
                result["last_7_days"][bucket][name] += value
                if day_value == today:
                    result["today"][bucket][name] += value
        if day_value == today:
            tests = data.get("test") if isinstance(data.get("test"), dict) else {}
            for name in CAPI_EVENTS:
                result["test_today"][name] += as_int(tests.get(name))
        for err in data.get("errors") or []:
            if isinstance(err, dict):
                result["errors"].append({k: err.get(k) for k in ("at", "event", "test", "status", "code", "message", "fbtrace_id")})
    result["errors"].sort(key=lambda e: str(e.get("at") or ""))
    result["errors_7_days"] = len(result["errors"])
    result["last_error"] = result["errors"][-1] if result["errors"] else None
    result["errors"] = result["errors"][-20:]
    return result


def format_capi_lines(capi):
    lines = ["== Meta Conversions API (server-side, ad-click visits only) =="]
    if not capi or not capi.get("available"):
        lines.append("no CAPI events recorded yet")
        return lines
    for label, key in (("today", "today"), ("last 7 days", "last_7_days")):
        block = capi[key]
        lines.append(f"{label}: " + "  ".join(
            f"{name} sent {block['sent'][name]} failed {block['failed'][name]}" for name in CAPI_EVENTS))
    tests = capi.get("test_today") or {}
    if any(tests.values()):
        lines.append("test events today: " + "  ".join(f"{name} {tests[name]}" for name in CAPI_EVENTS))
    err = capi.get("last_error")
    if err:
        lines.append(f"last error: {format_zurich(err.get('at')) if err.get('at') else '?'} {err.get('event')} "
                     f"status {err.get('status')} code {err.get('code')} {err.get('message')} fbtrace_id {err.get('fbtrace_id')}")
    else:
        lines.append("last error: none in 7 days")
    return lines


def journal_capi_errors(capi, ops_journal, marker):
    """Mirror new CAPI errors into the root-only ops journal (the service user cannot write it)."""
    if not capi or not ops_journal:
        return 0
    marker = Path(marker)
    try:
        last = marker.read_text(encoding="utf-8").strip()
    except OSError:
        last = ""
    fresh = [e for e in capi.get("errors") or [] if str(e.get("at") or "") > last]
    for err in fresh:
        append_jsonl(ops_journal, {"at": err.get("at"), "operation": "capi_send", "event": "capi_error",
                                   "capi_event": err.get("event"), "test": err.get("test"), "status": err.get("status"),
                                   "code": err.get("code"), "message": err.get("message"), "fbtrace_id": err.get("fbtrace_id")})
    if fresh:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(str(fresh[-1].get("at")) + "\n", encoding="utf-8")
    return len(fresh)


def write_snapshot(snapshot, *, stats_dir, archive_dir, ops_journal, now):
    stats_dir = Path(stats_dir)
    archive_dir = Path(archive_dir)
    latest_json = stats_dir / "status-latest.json"
    latest_txt = stats_dir / "status-latest.txt"
    text = format_status_text(snapshot)
    save_json(latest_json, snapshot)
    # save_json writes mode 600; status files are not secret. Relax to 644.
    latest_json.chmod(0o644)
    save_text(latest_txt, text, mode=0o644)
    day = now.date().isoformat() if isinstance(now, datetime) else date.fromisoformat(str(now)[:10]).isoformat()
    archive_dir.mkdir(parents=True, exist_ok=True, mode=0o755)
    save_json(archive_dir / f"status-{day}.json", snapshot)
    (archive_dir / f"status-{day}.json").chmod(0o644)
    save_text(archive_dir / f"status-{day}.txt", text, mode=0o644)
    journal_capi_errors(snapshot.get("capi"), ops_journal, stats_dir / "capi" / ".journaled-through")
    if snapshot["meta_api_health"] != "OK" and ops_journal:
        error = snapshot.get("meta_api_error") or {}
        append_jsonl(ops_journal, {
            "at": snapshot["generated_at"],
            "operation": "status_snapshot",
            "event": "meta_api_health",
            "health": snapshot["meta_api_health"],
            "code": error.get("code"),
            "status": error.get("status"),
            "message": error.get("message"),
            "fbtrace_id": error.get("fbtrace_id"),
        })
    return {"json": str(latest_json), "txt": str(latest_txt), "archive": str(archive_dir / f"status-{day}.txt")}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token-file", default=TOKEN_PATH)
    parser.add_argument("--stats-dir", default=str(DEFAULT_STATS))
    parser.add_argument("--archive-dir", default=str(DEFAULT_STATS / "status-archive"))
    parser.add_argument("--ops-journal", default=str(DEFAULT_JOURNAL))
    parser.add_argument("--dry-run", action="store_true",
                        help="Validate the plan and print it; no API, Docker, or file writes.")
    parser.add_argument("--allow-non-vps", action="store_true",
                        help="Override the VPS-only guard. Do not use this to call Meta from the box.")
    args = parser.parse_args(argv)
    now = datetime.now(ZURICH)
    generated_on = "vps" if on_vps() else "non-vps"
    if args.dry_run:
        print_result({
            "dry_run": True,
            "read_only": True,
            "generated_on": generated_on,
            "windows": {key: {"since": window["since"], "until": window["until"]}
                        for key, window in windows_for(now.date()).items()},
            "writes": {
                "json": str(Path(args.stats_dir) / "status-latest.json"),
                "txt": str(Path(args.stats_dir) / "status-latest.txt"),
                "archive": str(Path(args.archive_dir) / f"status-{now.date().isoformat()}.txt"),
                "ops_journal": args.ops_journal,
            },
            "notes": [
                "Run this on the VPS only. Agents never log in to Facebook from the box browser.",
                "All Meta data comes from token-based scripts on the VPS.",
            ],
        })
        return
    if not on_vps() and not args.allow_non_vps:
        raise OperationError("Status snapshots must run on the VPS, not the box.")
    client = MetaClient(args.token_file, read_only=True)
    snapshot = build_snapshot(
        client, now=now, stats_dir=args.stats_dir, listmonk_fn=listmonk_counts, generated_on=generated_on,
    )
    paths = write_snapshot(
        snapshot, stats_dir=args.stats_dir, archive_dir=args.archive_dir,
        ops_journal=args.ops_journal, now=now,
    )
    print_result({
        "read_only": True,
        "meta_api_health": snapshot["meta_api_health"],
        "generated_at": snapshot["generated_at"],
        "paths": paths,
        "meta_calls": snapshot.get("meta_calls"),
    })


if __name__ == "__main__":
    run_cli(main)
