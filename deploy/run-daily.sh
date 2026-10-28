#!/usr/bin/env bash
# Safety Radar daily run (VPS): code pull -> stage 1 pipeline -> e-mail intake -> stage 2 reviewer (validates, builds, commits)
# -> atomic publish of the build.
# GIT_PUSH=0 (default, VPS "local" mode): data is committed to the local main only, never pushed. Code arrives by
#   `git pull --rebase` from the public repo (https, read-only); local data commits are replayed on top (data files are only
#   changed on the VPS, code only on GitHub; on a conflict the local data wins, see docs/DEPLOY-VPS.md).
# GIT_PUSH=1 (GitHub Pages mode): fast-forward pull, the reviewer pushes to origin main.
# Used by deploy/systemd/safetyradar-update.service and the Docker image. Safe to re-run: the reviewer resumes or
# skips a finished day; a lock prevents overlapping runs.
#   Env (see .env.example): OPENAI_API_KEY, AGENTMAIL_API_KEY, GH_TOKEN (push mode only), GIT_PUSH, REVIEW_*, PUBLISH_DIR, SKIP_PULL, SKIP_INSTALL,
#   SKIP_STAGE1, SKIP_REVIEW, REVIEW_ARGS (e.g. "--dry-run").
set -Eeuo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
log() { echo "[run-daily $(TZ=Europe/Zurich date '+%F %T %Z')] $*"; }

exec 9>"${TMPDIR:-/tmp}/safetyradar-run-daily.lock"
flock -n 9 || { log "another run is in progress – exiting"; exit 0; }

# .env is optional here: systemd passes it via EnvironmentFile, compose via env_file. Never echo its contents.
if [[ -f .env && -z "${SAFETYRADAR_ENV_LOADED:-}" ]]; then set -a; . ./.env; set +a; export SAFETYRADAR_ENV_LOADED=1; fi
export TZ=Europe/Zurich NOINDEX="${NOINDEX:-1}" GIT_PUSH="${GIT_PUSH:-0}"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || { log "Node >= 22.19 required (have $(node -v))"; exit 1; }

if [[ -z "${SKIP_PULL:-}" ]]; then
  git checkout --quiet main
  if [[ "$GIT_PUSH" == 1 ]]; then
    log "git pull (ff-only)"; git pull --ff-only --quiet
  else
    # Replay local data commits on top of the public code. -X theirs = in a rebase, the local commit being replayed wins a
    # conflicting hunk (data is owned by the VPS). Any failure: abort and run with the code we already have.
    log "git pull --rebase (code from origin, local data commits kept)"
    before=$(git rev-parse HEAD)
    if ! git -c rebase.autoStash=true pull --quiet --rebase --strategy-option=theirs --no-edit origin main; then
      git rebase --abort 2>/dev/null || true; git reset --quiet --hard "$before"
      log "WARNING: pull --rebase failed – continuing with the current code"; status_pull=1
    elif ! node scripts/validate-data.mjs >/dev/null 2>&1; then
      git reset --quiet --hard "$before"; log "WARNING: data invalid after pull – reverted to $(git rev-parse --short HEAD)"; status_pull=1
    fi
  fi
fi
if [[ -z "${SKIP_INSTALL:-}" ]]; then
  log "npm ci"; npm ci --no-audit --no-fund --loglevel=error; npm --prefix reviewer ci --no-audit --no-fund --loglevel=error
fi

status=${status_pull:-0}
if [[ -z "${SKIP_STAGE1:-}" ]]; then
  log "stage 1: npm run update"; npm run update || { log "WARNING: stage 1 failed"; status=1; }
fi

log "e-mail intake"
node scripts/email-intake.mjs || { log "WARNING: e-mail intake failed – reviewer continues without new mail"; }

if [[ -z "${SKIP_REVIEW:-}" ]]; then
  log "stage 2: reviewer ${REVIEW_ARGS:-}"
  # shellcheck disable=SC2086
  npm --prefix reviewer run --silent review -- ${REVIEW_ARGS:-} || { rc=$?; log "WARNING: reviewer exit $rc"; [[ $rc -eq 3 ]] || status=1; }
fi

# Publish. Push mode: pull what the reviewer pushed (GitHub Pages builds main on its own). Local mode: main already has it.
publish() {
  local dir="${PUBLISH_DIR%/}"
  if [[ -d "$dir" && ! -L "$dir" ]]; then   # plain directory (e.g. /var/www/safetyradar): sync, delete stale files last
    log "publish dist/ -> $dir (rsync)"; rsync -a --delete-after dist/ "$dir"/; return
  fi
  # Symlink mode (atomic): $dir -> $dir.releases/<stamp>; switch the link with rename(2), keep the last 5 releases.
  local rel="$dir.releases" stamp; stamp=$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)
  mkdir -p "$rel"; rm -rf "$rel/$stamp.tmp"; cp -a dist "$rel/$stamp.tmp"; chmod -R a+rX "$rel/$stamp.tmp"; mv -T "$rel/$stamp.tmp" "$rel/$stamp"
  ln -sfn "$rel/$stamp" "$dir.new" && mv -T "$dir.new" "$dir"
  log "publish dist/ -> $dir -> $rel/$stamp (atomic symlink)"
  ls -1d "$rel"/*/ 2>/dev/null | sort | head -n -5 | while read -r d; do [[ "$(readlink -f "$dir")/" == "$d" ]] || rm -rf "$d"; done
}
if [[ -n "${PUBLISH_DIR:-}" ]]; then
  if [[ "$GIT_PUSH" == 1 && -z "${SKIP_PULL:-}" ]]; then git pull --ff-only --quiet || { log "WARNING: pull after review failed"; status=1; }; fi
  rm -rf dist
  NOINDEX="$NOINDEX" npm run --silent build || { log "ERROR: build failed – not publishing"; exit 1; }
  [[ -f dist/index.html ]] || { log "ERROR: dist/index.html missing – not publishing"; exit 1; }
  publish
fi
log "done (status $status)"
exit $status
