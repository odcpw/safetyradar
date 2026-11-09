#!/usr/bin/env python3
"""Publish one specifically approved Reel. Default safety requires an explicit mode."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from meta_common import (IG_USER_ID, STATE_DIR, TOKEN_PATH, MetaClient, OperationError,
                         caption_key, digest_file, fingerprint, load_json, operation_lock,
                         print_result, probe_video, read_text, run_cli, save_json)


def recent_duplicate(client, caption):
    key = caption_key(caption)
    for row in client.pages(f"{IG_USER_ID}/media", {"fields": "id,caption,timestamp,permalink", "limit": 100}, max_pages=10):
        if caption_key(row.get("caption", "")) == key:
            return {"media_id": row["id"], "permalink": row.get("permalink")}
    return None


def cleanup_temp(state):
    name = state.get("temp_name", "")
    if name and re.fullmatch(r"sr-[0-9a-f]{32}\.mp4", name):
        # Both values come only from our root-private journal. Never accept an arbitrary file path.
        parent = Path(state["public_root"]) / "media-tmp"
        target = parent / name
        if parent.is_dir() and not target.is_symlink():
            target.unlink(missing_ok=True)


def publish(client, args, caption, identity):
    state_dir = Path(args.state_dir)
    journal = state_dir / f"reel-{identity}.json"
    with operation_lock(state_dir, "instagram-publish"):
        state = load_json(journal)
        duplicate = recent_duplicate(client, caption)
        if duplicate:
            state.update({"phase": "published", **duplicate})
            save_json(journal, state)
            cleanup_temp(state)
            return {"duplicate": True, **duplicate}
        if state.get("media_id"):
            existing = client.get(state["media_id"], {"fields": "id,permalink"})
            cleanup_temp(state)
            return {"duplicate": True, "media_id": existing["id"], "permalink": existing.get("permalink")}
        if state.get("phase") in ("container_create_pending", "publish_pending"):
            raise OperationError("Previous Meta write has an uncertain result. Reconcile the saved container/recent media manually; no automatic repeat.")
        if state.get("phase") == "failed":
            cleanup_temp(state)
            raise OperationError("This operation reached a terminal container error. Review the saved state; do not clear it to retry blindly.")
        if not state.get("container_id"):
            cleanup_temp(state)
            root = Path(args.public_root).resolve(strict=True)
            if not root.is_dir():
                raise OperationError("Public root is not a directory.")
            public_dir = root / "media-tmp"
            public_dir.mkdir(exist_ok=True, mode=0o755)
            if public_dir.is_symlink():
                raise OperationError("Temporary public directory must not be a symlink.")
            name = "sr-" + uuid.uuid4().hex + ".mp4"
            state = {"identity": identity, "approval_ref": args.approval_ref,
                     "phase": "prepared", "public_root": str(root), "temp_name": name}
            save_json(journal, state)
            target = public_dir / name
            try:
                # Exclusive create prevents replacing a pre-existing file or following a symlink.
                with Path(args.mp4).open("rb") as source, target.open("xb") as dest:
                    shutil.copyfileobj(source, dest)
                target.chmod(0o644)
                url = args.public_base.rstrip("/") + "/media-tmp/" + name
                with urllib.request.urlopen(url, timeout=30) as response:
                    if hashlib.sha256(response.read(Path(args.mp4).stat().st_size + 1)).hexdigest() != digest_file(args.mp4):
                        raise OperationError("Temporary HTTPS URL does not return the exact approved MP4.")
            except BaseException:
                cleanup_temp(state)
                raise
            state["phase"] = "container_create_pending"
            save_json(journal, state)
            created = client.post(f"{IG_USER_ID}/media", {"media_type": "REELS", "video_url": url, "caption": caption})
            if not created.get("id"):
                raise OperationError("Container creation returned no ID; reconcile before retrying.")
            state.update({"container_id": created["id"], "phase": "processing"})
            save_json(journal, state)
        deadline = time.monotonic() + args.timeout
        while True:
            result = client.get(state["container_id"], {"fields": "status_code"})
            status = result.get("status_code")
            if status == "FINISHED":
                break
            if status in ("ERROR", "EXPIRED"):
                state.update({"phase": "failed", "container_status": status})
                save_json(journal, state)
                cleanup_temp(state)
                raise OperationError(f"Container ended in {status}; temporary file removed.")
            if status == "PUBLISHED":
                cleanup_temp(state)
                raise OperationError("Container already published but its media ID is not recovered. Inspect recent media; do not publish again.")
            if status != "IN_PROGRESS":
                raise OperationError("Unexpected container status; state and temporary video retained.")
            if time.monotonic() >= deadline:
                raise OperationError("Container still processing. State and temporary video retained for a safe resume.")
            time.sleep(min(args.poll_seconds, max(0, deadline - time.monotonic())))
        duplicate = recent_duplicate(client, caption)
        if duplicate:
            state.update({"phase": "published", **duplicate})
            save_json(journal, state)
            cleanup_temp(state)
            return {"duplicate": True, **duplicate}
        state["phase"] = "publish_pending"
        save_json(journal, state)
        # One attempt only. A timeout leaves publish_pending and blocks a second POST.
        try:
            published = client.post(f"{IG_USER_ID}/media_publish", {"creation_id": state["container_id"]})
            if not published.get("id"):
                raise OperationError("Publish returned no media ID; reconcile recent media before any retry.")
            state.update({"media_id": published["id"], "phase": "published"})
            save_json(journal, state)
        finally:
            # FINISHED means Meta has fetched the video, even if publish response was lost.
            cleanup_temp(state)
        media = client.get(state["media_id"], {"fields": "id,permalink"})
        state["permalink"] = media.get("permalink")
        save_json(journal, state)
        if not state["permalink"]:
            raise OperationError("Media ID saved but permalink unavailable. Read that ID; do not republish.")
        return {"duplicate": False, "media_id": state["media_id"], "permalink": state["permalink"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mp4")
    parser.add_argument("caption_file")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="No writes, public copies, locks, or state files")
    mode.add_argument("--execute", action="store_true", help="Publish only after specific owner approval")
    parser.add_argument("--approval-ref", help="Record of the owner's approval, required for --execute")
    parser.add_argument("--check-remote", action="store_true", help="In dry-run, also read recent media for duplicate captions")
    parser.add_argument("--token-file", default=TOKEN_PATH)
    parser.add_argument("--state-dir", default=STATE_DIR)
    parser.add_argument("--public-root", default="/srv/safetyradar/www")
    parser.add_argument("--public-base", default="https://safetyradar.ch")
    parser.add_argument("--poll-seconds", type=int, default=60)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args(argv)
    if args.execute and not (args.approval_ref and args.approval_ref.strip()):
        parser.error("--execute requires --approval-ref. A flag is not permission; obtain owner approval first.")
    parsed = urllib.parse.urlsplit(args.public_base)
    if (parsed.scheme != "https" or parsed.netloc != "safetyradar.ch" or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment):
        parser.error("--public-base must be https://safetyradar.ch.")
    if not 15 <= args.poll_seconds <= 120 or not 60 <= args.timeout <= 900:
        parser.error("Use polling 15..120 seconds and timeout 60..900 seconds.")
    metadata = probe_video(args.mp4, reel=True)
    caption = read_text(args.caption_file)
    identity = fingerprint({"ig_user_id": IG_USER_ID, "video_sha256": digest_file(args.mp4),
                            "caption": caption_key(caption)})
    client = MetaClient(args.token_file, read_only=args.dry_run)
    if args.dry_run:
        result = {"dry_run": True, "writes": False, "identity": identity, "video": metadata,
                  "caption_chars": len(caption), "ig_user_id": IG_USER_ID,
                  "would": ["check recent captions", "temporarily serve approved MP4", "create REELS container",
                            "poll FINISHED", "recheck duplicates", "publish once", "save permalink", "remove public MP4"]}
        if args.check_remote:
            result["existing_media"] = recent_duplicate(client, caption)
        print_result(result)
        return
    print_result(publish(client, args, caption, identity))


if __name__ == "__main__":
    run_cli(main)
