#!/usr/bin/env python3
"""OnFailure= hook: append one pipeline_failed entry to the root-only ops journal. No secrets: unit state + error lines."""
from datetime import datetime
import json
from pathlib import Path
import subprocess
import sys
from zoneinfo import ZoneInfo

JOURNAL = Path("/srv/safetyradar/ops/journal.jsonl")


def show(unit):
    out = subprocess.run(["systemctl", "show", unit, "-p", "InvocationID", "-p", "Result", "-p", "ExecMainStatus"],
                         capture_output=True, text=True, timeout=20).stdout
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def error_lines(invocation, limit=8):
    if not invocation:
        return []
    out = subprocess.run(["journalctl", f"_SYSTEMD_INVOCATION_ID={invocation}", "-o", "cat", "--no-pager"],
                         capture_output=True, text=True, timeout=30).stdout.splitlines()
    picked = [l for l in out if "[run-daily" in l and ("ERROR" in l or "WARNING" in l)]
    stale = sum("missing or stale review" in l for l in out)
    if stale:
        picked.append(f"{stale} x 'missing or stale review' from validate-data")
    return [l[:300] for l in picked[-limit:]]


def main(unit):
    props = show(unit)
    entry = {"at": datetime.now(ZoneInfo("Europe/Zurich")).isoformat(), "event": "pipeline_failed", "unit": unit,
             "result": props.get("Result"), "exit_status": props.get("ExecMainStatus"),
             "invocation": props.get("InvocationID"), "lines": error_lines(props.get("InvocationID"))}
    JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    with JOURNAL.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    JOURNAL.chmod(0o600)
    print(json.dumps({k: entry[k] for k in ("event", "unit", "result", "exit_status")}))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "safetyradar-update.service")
