#!/usr/bin/env python3
"""Read-only Safety Radar status snapshot. Run on the VPS only; never call Meta from the box."""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import subprocess
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from meta_common import (
    ACCOUNT_ID,
    CAMPAIGN_ID,
    IG_USER_ID,
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
            lines.append(f"{title} {period['since']} through {period['until']}")
            campaign_block = period["campaign"]
            extra = ""
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
                f"  {item.get('timestamp') or '—'} {item.get('permalink') or '—'}  "
                f"plays={item.get('plays') if item.get('plays') is not None else '—'} "
                f"reach={item.get('reach') if item.get('reach') is not None else '—'} "
                f"likes={likes if likes is not None else '—'}"
            )
        for note in ig.get("notes") or []:
            lines.append(f"  note: {note}")
        lines.append("")

    analytics = snapshot.get("analytics") or {}
    lines.append("== Website analytics ==")
    if analytics.get("text"):
        lines.append(analytics["text"].rstrip())
    elif analytics.get("available"):
        metrics = analytics.get("metrics") or {}
        lines.append(
            f"pageviews {metrics.get('pageviews', 0)}  "
            f"signupSubmissions {metrics.get('signupSubmissions', 0)}  "
            f"signupAcceptedResponses {metrics.get('signupAcceptedResponses', 0)}  "
            f"signupConfirmedResponses {metrics.get('signupConfirmedResponses', 0)}"
        )
        lines.append("Campaign cohorts (views / submissions / accepted / confirmed):")
        for row in analytics.get("byCampaign") or []:
            lines.append(
                f"{row.get('source')} {row.get('campaign')} {row.get('variant')}: "
                f"{row.get('pageviews')} / {row.get('signupSubmissions')} / "
                f"{row.get('signupAcceptedResponses')} / {row.get('signupConfirmedResponses')}"
            )
    else:
        lines.append(analytics.get("error") or "unavailable")
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
    try:
        snapshot["ads"] = collect_ads(collector, windows_for(today))
        snapshot["instagram"] = collect_instagram(collector)
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
    try:
        counts = listmonk_fn()
        snapshot["listmonk"] = {"available": True, **counts}
    except OperationError as exc:
        snapshot["listmonk"] = {"available": False, "error": str(exc)}
    return snapshot


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
