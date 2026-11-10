#!/usr/bin/env python3
"""Publish one specifically approved Reel. Default safety requires an explicit mode."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import os
import subprocess
from datetime import datetime
from zoneinfo import ZoneInfo
import time
import urllib.parse
import urllib.request
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from meta_common import (IG_USER_ID, STATE_DIR, TOKEN_PATH, MetaClient, MetaAPIError, OperationError,
                         caption_key, digest_file, fingerprint, load_json, operation_lock,
                         print_result, probe_video, read_text, run_cli, save_json)


def recent_duplicate(client, caption):
    key = caption_key(caption)
    for row in client.pages(f"{IG_USER_ID}/media", {"fields": "id,caption,timestamp,permalink", "limit": 100}, max_pages=10):
        if caption_key(row.get("caption", "")) == key:
            return {"media_id": row["id"], "permalink": row.get("permalink")}
    return None


def cleanup_temp(state):
    for name in (state.get("temp_name", ""), state.get("cover_name", "")):
        if name and re.fullmatch(r"sr-[0-9a-f]{32}\.(mp4|jpg)", name):
            parent = Path(state["public_root"]) / "media-tmp"
            target = parent / name
            if parent.is_dir() and not target.is_symlink():
                target.unlink(missing_ok=True)


def marker_path(args):
    return Path(args.published_dir) / (args.marker_key + ".json")


def check_markers(client, args, identity):
    """Check all agentic records under the same publishing lock. Never guess a lost write."""
    candidates = list(dict.fromkeys([marker_path(args), *Path(args.published_dir).glob("*.json"),
                                    *Path(args.state_dir).glob("reel-*.json")]))
    records = [(str(path), load_json(path)) for path in candidates if path.exists()]
    journal = Path(args.ops_journal)
    if journal.exists():
        try:
            records += [(str(journal), json.loads(line)) for line in journal.read_text().splitlines() if line.strip()]
        except (OSError, ValueError):
            raise OperationError("Ops journal cannot be checked; no publish attempted.") from None
    own_journal = str(Path(args.state_dir) / f"reel-{identity}.json")
    for path, row in records:
        if not isinstance(row, dict):
            raise OperationError("Publication record is invalid; no publish attempted.")
        related = (path == str(marker_path(args)) or row.get("identity") == identity
                   or (args.approval_ref and row.get("approval_ref") == args.approval_ref)
                   or row.get("marker_key") == args.marker_key
                   or (row.get("video_sha256") and row["video_sha256"] == digest_file(args.mp4))
                   or (row.get("caption_sha256") and row["caption_sha256"] == digest_file(args.caption_file)))
        if not related:
            continue
        if row.get("media_id") or row.get("permalink") or row.get("phase") == "published" or row.get("container_status") == "PUBLISHED":
            return {"media_id": row.get("media_id"), "permalink": row.get("permalink"), "marker": path}
        # The active job resumes its own saved container below, never creates another one.
        if path != own_journal and (path == str(marker_path(args)) or row.get("container_id")
                                   or row.get("phase") in ("container_create_pending", "publish_pending")):
            status = client.get(row["container_id"], {"fields": "status_code"}).get("status_code") if row.get("container_id") else "UNKNOWN"
            raise OperationError(f"Another publication record is unresolved (container status {status}). No new POST attempted.")
    return None


def duplicate_check(client, args, caption, identity):
    existing = check_markers(client, args, identity)
    if existing:
        return existing
    try:
        return recent_duplicate(client, caption)
    except MetaAPIError as exc:
        if not args.allow_marker_guard or exc.code != 10:
            raise
        # Explicit operator choice for this approved post, not a generic permission bypass.
        return check_markers(client, args, identity)


def record_published(args, state, *, log_event=None):
    record = {k: state[k] for k in ("identity", "approval_ref", "container_id", "media_id", "permalink",
                                    "video_sha256", "caption_sha256", "cover_source_sha256", "marker_guard_authorized") if k in state}
    record.update({"phase": "published", "marker_key": args.marker_key, "ig_user_id": IG_USER_ID,
                   "shared_to_feed": True, "at": datetime.now(ZoneInfo("Europe/Zurich")).isoformat()})
    save_json(marker_path(args), record)
    if log_event is None:
        return
    path = Path(args.ops_journal)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a", encoding="utf-8") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(json.dumps({"event": log_event, **record}, ensure_ascii=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def publish(client, args, caption, identity):
    state_dir = Path(args.state_dir)
    journal = state_dir / f"reel-{identity}.json"
    with operation_lock(state_dir, "instagram-publish"):
        state = load_json(journal)
        duplicate = duplicate_check(client, args, caption, identity)
        if duplicate:
            state.update({"phase": "published", **duplicate})
            save_json(journal, state)
            cleanup_temp(state)
            return {"duplicate": True, **duplicate}
        if state.get("container_id") and state.get("cover_source_sha256") != (digest_file(args.cover_file) if args.cover_file else None):
            raise OperationError("Saved container has a different cover; inspect it instead of substituting an asset.")
        if state.get("container_id") and state.get("caption_sha256") and state["caption_sha256"] != digest_file(args.caption_file):
            raise OperationError("Saved container has different caption bytes; no publish attempted.")
        if state.get("media_id"):
            existing = client.get(state["media_id"], {"fields": "id,permalink"})
            cleanup_temp(state)
            return {"duplicate": True, "media_id": existing["id"], "permalink": existing.get("permalink")}
        if state.get("phase") == "publish_pending":
            status = client.get(state["container_id"], {"fields": "status_code"}).get("status_code") if state.get("container_id") else "UNKNOWN"
            raise OperationError(f"Previous publish result is uncertain; container status is {status}. No second publish attempted.")
        if state.get("phase") == "container_create_pending":
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
                     "phase": "prepared", "ig_user_id": IG_USER_ID, "marker_key": args.marker_key,
                     "marker_guard_authorized": args.allow_marker_guard, "public_root": str(root), "temp_name": name,
                     "video_sha256": digest_file(args.mp4), "caption_sha256": digest_file(args.caption_file)}
            if args.cover_file:
                state.update({"cover_name": name[:-4] + ".jpg", "cover_source_sha256": digest_file(args.cover_file)})
            save_json(journal, state)
            target = public_dir / name
            try:
                # Exclusive create prevents replacing a pre-existing file or following a symlink.
                with Path(args.mp4).open("rb") as source, target.open("xb") as dest:
                    shutil.copyfileobj(source, dest)
                target.chmod(0o644)
                if args.cover_file:
                    cover = public_dir / state["cover_name"]
                    if Path(args.cover_file).suffix.lower() in (".jpg", ".jpeg"):
                        with Path(args.cover_file).open("rb") as source, cover.open("xb") as dest:
                            shutil.copyfileobj(source, dest)
                    else:
                        subprocess.run(["ffmpeg", "-v", "error", "-n", "-i", str(Path(args.cover_file).resolve()),
                                        "-frames:v", "1", "-q:v", "2", "-pix_fmt", "yuvj420p", str(cover)],
                                       capture_output=True, check=True, timeout=30)
                    cover.chmod(0o644)
                    if cover.stat().st_size > 8 * 1024 * 1024:
                        raise OperationError("Converted cover exceeds Meta's 8 MiB limit.")
                    cover_url = args.public_base.rstrip("/") + "/media-tmp/" + state["cover_name"]
                    with urllib.request.urlopen(cover_url, timeout=30) as response:
                        if hashlib.sha256(response.read(cover.stat().st_size + 1)).hexdigest() != digest_file(cover):
                            raise OperationError("Public cover differs from the prepared JPEG.")
                url = args.public_base.rstrip("/") + "/media-tmp/" + name
                with urllib.request.urlopen(url, timeout=30) as response:
                    if hashlib.sha256(response.read(Path(args.mp4).stat().st_size + 1)).hexdigest() != digest_file(args.mp4):
                        raise OperationError("Temporary HTTPS URL does not return the exact approved MP4.")
            except BaseException:
                cleanup_temp(state)
                raise
            state["phase"] = "container_create_pending"
            save_json(journal, state)
            payload = {"media_type": "REELS", "video_url": url, "caption": caption, "share_to_feed": "true"}
            if args.cover_file:
                payload["cover_url"] = cover_url
            try:
                created = client.post(f"{IG_USER_ID}/media", payload)
            except MetaAPIError as exc:
                if exc.status and 400 <= exc.status < 500:
                    state.update({"phase": "failed", "error_code": exc.code,
                                  "error_endpoint": f"{IG_USER_ID}/media", "error_method": "POST"})
                    save_json(journal, state)
                    cleanup_temp(state)
                raise
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
        duplicate = duplicate_check(client, args, caption, identity)
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
            record_published(args, state, log_event="reel_published")
        finally:
            # FINISHED means Meta has fetched the video, even if publish response was lost.
            cleanup_temp(state)
        media = client.get(state["media_id"], {"fields": "id,permalink"})
        state["permalink"] = media.get("permalink")
        save_json(journal, state)
        record_published(args, state)
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
    parser.add_argument("--published-dir", default="/srv/safetyradar/social/published")
    parser.add_argument("--ops-journal", default="/srv/safetyradar/ops/journal.jsonl")
    parser.add_argument("--marker-key", help="Stable post name; defaults to the MP4 basename")
    parser.add_argument("--allow-marker-guard", action="store_true", help="Only for explicitly approved agent-only posting: on recent-media GET code 10, use marker/journal checks")
    parser.add_argument("--approved-video-sha256", help="Pin an already approved original MP4; allow missing primaries/transfer tags without re-encoding")
    parser.add_argument("--cover-file", help="Approved PNG/JPEG; PNG is converted to JPEG for Meta's cover_url")
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
    args.marker_key = args.marker_key or Path(args.mp4).stem
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.marker_key):
        parser.error("--marker-key must be a plain filename stem.")
    if args.allow_marker_guard and not args.approval_ref:
        parser.error("--allow-marker-guard requires the specific post's --approval-ref.")
    if args.approved_video_sha256 and (not re.fullmatch(r"[0-9a-f]{64}", args.approved_video_sha256)
                                       or digest_file(args.mp4) != args.approved_video_sha256):
        parser.error("The video does not match the explicitly approved SHA-256.")
    if args.cover_file:
        path = Path(args.cover_file)
        with path.open("rb") as stream:
            magic = stream.read(8)
        if path.stat().st_size > 8 * 1024 * 1024 or not (magic == b"\x89PNG\r\n\x1a\n" or magic.startswith(b"\xff\xd8\xff")):
            parser.error("Cover must be a PNG/JPEG of at most 8 MiB.")
    metadata = probe_video(args.mp4, reel=True, allow_missing_color_tags=bool(args.approved_video_sha256))
    caption = read_text(args.caption_file, strip=False)
    identity = fingerprint({"ig_user_id": IG_USER_ID, "video_sha256": digest_file(args.mp4),
                            "caption": caption_key(caption)})
    client = MetaClient(args.token_file, read_only=args.dry_run)
    if args.dry_run:
        result = {"dry_run": True, "writes": False, "identity": identity, "video": metadata,
                  "caption_chars": len(caption), "ig_user_id": IG_USER_ID, "shared_to_feed": True,
                  "cover_source_sha256": digest_file(args.cover_file) if args.cover_file else None,
                  "would": ["check recent captions", "temporarily serve approved MP4", "create REELS container",
                            "poll FINISHED", "recheck duplicates", "publish once", "save permalink", "remove public MP4"]}
        if args.check_remote:
            result["existing_media"] = duplicate_check(client, args, caption, identity)
            result["marker_guard_allowed_for_code_10"] = args.allow_marker_guard
        print_result(result)
        return
    print_result(publish(client, args, caption, identity))


if __name__ == "__main__":
    run_cli(main)
