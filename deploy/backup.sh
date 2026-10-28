#!/usr/bin/env bash
# Nightly local backup (VPS local mode): a full `git bundle` of the app repo (all local data commits) plus a tarball of
# reviewer/state and the gitignored stage-1 state (queues, drafts, cache, llm-usage) into $BACKUP_DIR; keeps $BACKUP_KEEP_DAYS days.
# Never includes .env. Restore: `git clone app-<stamp>.bundle app` and untar state-<stamp>.tar.gz inside it.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
DIR="${BACKUP_DIR:-$HOME/backups}"; KEEP="${BACKUP_KEEP_DAYS:-14}"
stamp=$(TZ=Europe/Zurich date +%F-%H%M)
umask 077; mkdir -p "$DIR"
git bundle create --quiet "$DIR/app-$stamp.bundle" --all
git bundle verify --quiet "$DIR/app-$stamp.bundle" >/dev/null
paths=(); for p in reviewer/state data/queue.json data/jobs-queue.json data/llm-usage.jsonl data/drafts data/cache data/inbox; do [[ -e $p ]] && paths+=("$p"); done
tar --exclude='reviewer/state/worktree-*' -czf "$DIR/state-$stamp.tar.gz" "${paths[@]}"
find "$DIR" -maxdepth 1 -type f \( -name 'app-*.bundle' -o -name 'state-*.tar.gz' \) -mtime +"$KEEP" -delete
echo "[backup] $DIR/app-$stamp.bundle $(du -h "$DIR/app-$stamp.bundle" | cut -f1), state-$stamp.tar.gz $(du -h "$DIR/state-$stamp.tar.gz" | cut -f1)"
