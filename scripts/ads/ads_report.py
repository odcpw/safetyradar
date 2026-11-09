#!/usr/bin/env python3
"""Read-only CHF report for the approved Safety Radar Meta campaign."""
from __future__ import annotations

import argparse
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
import sys
from zoneinfo import ZoneInfo
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from meta_common import ACCOUNT_ID, CAMPAIGN_ID, TOKEN_PATH, MetaClient, OperationError, print_result, run_cli


def summarise(row):
    spend = Decimal(str(row.get("spend", "0")))
    impressions = int(row.get("impressions", 0))
    # action_type=link_click is deliberately distinct from all-click CPC/CTR.
    clicks = sum(int(Decimal(str(x.get("value", 0)))) for x in row.get("actions", [])
                 if x.get("action_type") == "link_click")
    return {"ad_id": row["ad_id"], "ad_name": row.get("ad_name", ""), "currency": "CHF",
            "spend": float(spend), "impressions": impressions, "reach": int(row.get("reach", 0)),
            "link_clicks": clicks,
            "link_cpc": round(float(spend / clicks), 4) if clicks else None,
            "link_ctr_pct": round(clicks / impressions * 100, 4) if impressions else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True, help="Inclusive date, YYYY-MM-DD, account timezone")
    parser.add_argument("--until", required=True, help="Inclusive date, YYYY-MM-DD, account timezone")
    parser.add_argument("--token-file", default=TOKEN_PATH)
    parser.add_argument("--dry-run", action="store_true", help="Validate and print request plan; no API calls")
    args = parser.parse_args(argv)
    try:
        since, until = date.fromisoformat(args.since), date.fromisoformat(args.until)
    except ValueError:
        parser.error("Dates must use YYYY-MM-DD.")
    if args.since != since.isoformat() or args.until != until.isoformat():
        parser.error("Dates must use YYYY-MM-DD.")
    if since > until:
        parser.error("--since must not be after --until.")
    client = MetaClient(args.token_file, read_only=True)
    query = {"level": "ad", "fields": "ad_id,ad_name,spend,impressions,reach,actions",
             "time_range": {"since": since.isoformat(), "until": until.isoformat()},
             "filtering": [{"field": "campaign.id", "operator": "IN", "value": [CAMPAIGN_ID]}]}
    if args.dry_run:
        print_result({"dry_run": True, "read_only": True, "path": f"act_{ACCOUNT_ID}/insights", "query": query})
        return
    account = client.get(f"act_{ACCOUNT_ID}", {"fields": "currency,timezone_name"})
    if account.get("currency") != "CHF":
        raise OperationError("Account currency is not CHF; refusing to label or convert the report.")
    rows = [summarise(row) for row in client.pages(f"act_{ACCOUNT_ID}/insights", query)]
    spend = sum(Decimal(str(row["spend"])) for row in rows)
    clicks = sum(row["link_clicks"] for row in rows)
    impressions = sum(row["impressions"] for row in rows)
    print_result({"read_only": True, "currency": "CHF", "account_timezone": account.get("timezone_name"),
                  "generated_at": datetime.now(ZoneInfo("Europe/Zurich")).isoformat(),
                  "since": since.isoformat(), "until": until.isoformat(), "ads": rows,
                  "totals": {"spend": float(spend), "impressions": impressions, "link_clicks": clicks,
                             "link_cpc": round(float(spend / clicks), 4) if clicks else None,
                             "link_ctr_pct": round(clicks / impressions * 100, 4) if impressions else None},
                  "notes": ["Date range is inclusive in the Meta account reporting timezone.",
                            "Reach is per ad; do not sum it as unique campaign reach.",
                            "CPC and CTR here use link clicks, not all clicks or website pageviews."]})


if __name__ == "__main__":
    run_cli(main)
