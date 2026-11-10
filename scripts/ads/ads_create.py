#!/usr/bin/env python3
"""Prepare a PAUSED-only video ad in the existing approved ad set. No activation API."""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from meta_common import (ACCOUNT_ID, ADSET_ID, CAMPAIGN_ID, DESTINATION, AD_IG_USER_ID as IG_USER_ID, PAGE_ID,
                         STATE_DIR, TOKEN_PATH, MetaClient, OperationError, digest_file,
                         fingerprint, load_json, operation_lock, print_result, probe_video,
                         read_text, run_cli, save_json)


def ad_payload(name, creative_id):
    # Deliberately no status, budget, account, or ad-set override exposed in the CLI.
    return {"name": name, "adset_id": ADSET_ID, "creative": {"creative_id": creative_id}, "status": "PAUSED"}


def check_account(client):
    account = client.get(f"act_{ACCOUNT_ID}", {"fields": "currency,timezone_name"})
    adset = client.get(ADSET_ID, {"fields": "id,account_id,campaign_id"})
    if (account.get("currency") != "CHF" or adset.get("id") != ADSET_ID
            or adset.get("account_id") != ACCOUNT_ID or adset.get("campaign_id") != CAMPAIGN_ID):
        raise OperationError("Account, CHF currency, or existing ad-set/campaign identity does not match the approved setup.")
    return {"currency": "CHF", "account_timezone": account.get("timezone_name"), "adset_id": ADSET_ID}


def find_named(client, resource, name, *, name_field="name", fields="id,name"):
    rows = [row for row in client.pages(f"act_{ACCOUNT_ID}/{resource}", {"fields": fields})
            if row.get(name_field) == name]
    unique = {row.get("id", row.get("hash")): row for row in rows}
    if len(unique) > 1:
        raise OperationError("More than one remote object matches this operation. Reconcile manually; no duplicate will be created.")
    return next(iter(unique.values()), None)


def verify_paused_ad(client, ad_id, creative_id=None):
    row = client.get(ad_id, {"fields": "id,name,status,adset_id,creative{id}"})
    if row.get("status") != "PAUSED" or row.get("adset_id") != ADSET_ID:
        raise OperationError("Existing ad is not PAUSED in the approved ad set. Nothing was changed.")
    if creative_id and row.get("creative", {}).get("id") != creative_id:
        raise OperationError("Existing ad points at a different creative. Nothing was changed.")
    return {"ad_id": row["id"], "name": row.get("name"), "status": "PAUSED", "adset_id": ADSET_ID}


def create_paused(client, args, identity, name, creative_spec, tags):
    state_dir = Path(args.state_dir)
    journal = state_dir / f"ad-{identity}.json"
    with operation_lock(state_dir, "ads-create"):
        check_account(client)
        state = load_json(journal)
        existing = find_named(client, "ads", name, fields="id,name,status,adset_id")
        if existing:
            result = verify_paused_ad(client, existing["id"], state.get("creative_id"))
            state.update({"ad_id": result["ad_id"], "phase": "complete"})
            save_json(journal, state)
            return {"existing": True, **result}
        if state.get("ad_id"):
            return {"existing": True, **verify_paused_ad(client, state["ad_id"], state.get("creative_id"))}
        state.setdefault("identity", identity)
        state.setdefault("name", name)
        state.setdefault("approval_ref", args.approval_ref)
        for field, pending, resource, remote_field, fields in (
            ("video_id", "video_upload_pending", "advideos", "title", "id,title"),
            ("image_hash", "image_upload_pending", "adimages", "name", "hash,name"),
            ("creative_id", "creative_create_pending", "adcreatives", "name", "id,name"),
        ):
            if state.get("phase") == pending and not state.get(field):
                remote_name = state.get("image_upload_name") if field == "image_hash" else name
                found = find_named(client, resource, remote_name, name_field=remote_field, fields=fields)
                if not found:
                    raise OperationError("Previous write is uncertain and not found remotely. Wait/reconcile the private journal; no automatic repeat.")
                state[field] = found["hash" if field == "image_hash" else "id"]
                state["phase"] = "recovered"
                save_json(journal, state)
        if state.get("phase") == "ad_create_pending":
            raise OperationError("Previous ad creation has an uncertain result. Recheck later or reconcile manually; no automatic second ad.")
        if not state.get("video_id"):
            state["phase"] = "video_upload_pending"
            save_json(journal, state)
            uploaded = client.post(f"act_{ACCOUNT_ID}/advideos", {"title": name},
                                   upload=("source", args.mp4, "sr-" + identity[:16] + ".mp4"))
            if not uploaded.get("id"):
                raise OperationError("Video upload returned no ID. Reconcile the journal before retrying.")
            state.update({"video_id": uploaded["id"], "phase": "video_processing"})
            save_json(journal, state)
        deadline = time.monotonic() + args.timeout
        while True:
            status = client.get(state["video_id"], {"fields": "status"}).get("status", {}).get("video_status")
            if status == "ready":
                break
            if status in ("error", "expired"):
                raise OperationError("Ad video processing failed. Preserve its journal and review the video.")
            if status not in ("processing", "uploading"):
                raise OperationError("Unexpected ad video status. Preserve the journal; no replacement upload.")
            if time.monotonic() >= deadline:
                raise OperationError("Ad video still processing. Re-run with the same inputs to resume its saved video ID.")
            time.sleep(min(args.poll_seconds, max(0, deadline - time.monotonic())))
        if not state.get("image_hash"):
            upload_name = "sr-" + identity[:16] + Path(args.thumbnail).suffix.lower()
            state.update({"phase": "image_upload_pending", "image_upload_name": upload_name})
            save_json(journal, state)
            uploaded = client.post(f"act_{ACCOUNT_ID}/adimages", upload=("filename", args.thumbnail, upload_name))
            images = list(uploaded.get("images", {}).values())
            if len(images) != 1 or not images[0].get("hash"):
                raise OperationError("Image upload returned no unique hash. Reconcile before retrying.")
            state.update({"image_hash": images[0]["hash"], "phase": "image_ready"})
            save_json(journal, state)
        if not state.get("creative_id"):
            spec = {"page_id": PAGE_ID, "instagram_user_id": IG_USER_ID,
                    "video_data": {**creative_spec, "video_id": state["video_id"], "image_hash": state["image_hash"]}}
            state["phase"] = "creative_create_pending"
            save_json(journal, state)
            creative = client.post(f"act_{ACCOUNT_ID}/adcreatives", {"name": name, "object_story_spec": spec, "url_tags": tags})
            if not creative.get("id"):
                raise OperationError("Creative creation returned no ID. Reconcile before retrying.")
            state.update({"creative_id": creative["id"], "phase": "creative_ready"})
            save_json(journal, state)
        state["phase"] = "ad_create_pending"
        save_json(journal, state)
        ad = client.post(f"act_{ACCOUNT_ID}/ads", ad_payload(name, state["creative_id"]))
        if not ad.get("id"):
            raise OperationError("Ad creation returned no ID. Reconcile before retrying.")
        state.update({"ad_id": ad["id"], "phase": "ad_created"})
        save_json(journal, state)
        result = verify_paused_ad(client, state["ad_id"], state["creative_id"])
        state["phase"] = "complete"
        save_json(journal, state)
        return {"existing": False, **result, "video_id": state["video_id"], "creative_id": state["creative_id"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mp4")
    parser.add_argument("--thumbnail", required=True, help="Reviewed local PNG or JPEG")
    parser.add_argument("--message-file", required=True, help="Approved UTF-8 German message")
    parser.add_argument("--name", required=True)
    parser.add_argument("--variant", required=True, choices=("a", "b", "c"))
    parser.add_argument("--utm-campaign", default="de-2026-w46")
    parser.add_argument("--title", default="Safety Radar Newsletter")
    parser.add_argument("--description", default="Wöchentlich das Wichtigste.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="No Meta writes or local state changes")
    mode.add_argument("--execute", action="store_true", help="Create PAUSED objects only, after owner approval")
    parser.add_argument("--approval-ref")
    parser.add_argument("--check-remote", action="store_true", help="Also validate the account/ad set in dry-run (GET only)")
    parser.add_argument("--token-file", default=TOKEN_PATH)
    parser.add_argument("--state-dir", default=STATE_DIR)
    parser.add_argument("--poll-seconds", type=int, default=60)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args(argv)
    if args.execute and not (args.approval_ref and args.approval_ref.strip()):
        parser.error("--execute requires --approval-ref. A flag is not permission; obtain owner approval first.")
    if not re.fullmatch(r"de-\d{4}-w(?:0[1-9]|[1-4][0-9]|5[0-3])", args.utm_campaign):
        parser.error("--utm-campaign must be de-YYYY-wNN.")
    if not args.name.strip() or len(args.name) > 180 or len(args.title) > 100 or len(args.description) > 200:
        parser.error("Supply a name of 1..180 characters, title <=100, and description <=200.")
    if not 15 <= args.poll_seconds <= 120 or not 60 <= args.timeout <= 900:
        parser.error("Use polling 15..120 seconds and timeout 60..900 seconds.")
    metadata = probe_video(args.mp4)
    thumb = Path(args.thumbnail)
    try:
        with thumb.open("rb") as handle:
            magic = handle.read(8)
        valid_image = (thumb.suffix.lower() == ".png" and magic == b"\x89PNG\r\n\x1a\n") or (thumb.suffix.lower() in (".jpg", ".jpeg") and magic.startswith(b"\xff\xd8\xff"))
        if not valid_image or thumb.stat().st_size > 8 * 1024 * 1024:
            raise OperationError("Thumbnail must be a PNG/JPEG of at most 8 MiB.")
    except OSError:
        raise OperationError("Cannot read the thumbnail file.") from None
    message = read_text(args.message_file)
    tags = f"utm_source={{{{site_source_name}}}}&utm_medium=paid_social&utm_campaign={args.utm_campaign}&utm_content={args.variant}"
    spec = {"title": args.title, "message": message, "link_description": args.description,
            "call_to_action": {"type": "SIGN_UP", "value": {"link": DESTINATION}}}
    identity = fingerprint({"video": digest_file(args.mp4), "image": digest_file(thumb), "spec": spec,
                            "tags": tags, "adset_id": ADSET_ID, "name": args.name.strip()})
    name = f"{args.name.strip()} [sr-{identity[:16]}]"
    client = MetaClient(args.token_file, read_only=args.dry_run)
    if args.dry_run:
        result = {"dry_run": True, "writes": False, "identity": identity, "name": name,
                  "video": metadata, "object_story_spec": {"page_id": PAGE_ID, "instagram_user_id": IG_USER_ID,
                  "video_data": {**spec, "video_id": "<uploaded-video-id>", "image_hash": "<uploaded-image-hash>"}},
                  "url_tags": tags, "ad": ad_payload(name, "<created-creative-id>"),
                  "would": ["validate CHF and existing ad set", "upload video and thumbnail", "create creative", "create PAUSED ad", "read back status"],
                  "activation_supported": False, "budget_changes_supported": False}
        if args.check_remote:
            result["account"] = check_account(client)
        print_result(result)
        return
    print_result(create_paused(client, args, identity, name, spec, tags))


if __name__ == "__main__":
    run_cli(main)
