#!/usr/bin/env bash
# Safety Radar daily run (VPS): stage 1 pipeline -> e-mail intake -> stage 2 reviewer -> review PR -> publish build.
# Used by deploy/systemd/safetyradar-update.service and the Docker image. Safe to re-run: the reviewer resumes or
# skips a finished day; a lock prevents overlapping runs.
#   Env (see .env.example): OPENAI_API_KEY, AGENTMAIL_API_KEY, GH_TOKEN, REVIEW_*, PUBLISH_DIR, SKIP_PULL, SKIP_INSTALL,
#   SKIP_STAGE1, SKIP_REVIEW, REVIEW_ARGS (e.g. "--dry-run").
set -Eeuo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
log() { echo "[run-daily $(TZ=Europe/Zurich date '+%F %T %Z')] $*"; }

exec 9>"${TMPDIR:-/tmp}/safetyradar-run-daily.lock"
flock -n 9 || { log "another run is in progress – exiting"; exit 0; }

# .env is optional here: systemd passes it via EnvironmentFile, compose via env_file. Never echo its contents.
if [[ -f .env && -z "${SAFETYRADAR_ENV_LOADED:-}" ]]; then set -a; . ./.env; set +a; export SAFETYRADAR_ENV_LOADED=1; fi
export TZ=Europe/Zurich NOINDEX="${NOINDEX:-1}"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || { log "Node >= 22.19 required (have $(node -v))"; exit 1; }

if [[ -z "${SKIP_PULL:-}" ]]; then
  log "git pull"; git checkout --quiet main; git pull --ff-only --quiet
fi
if [[ -z "${SKIP_INSTALL:-}" ]]; then
  log "npm ci"; npm ci --no-audit --no-fund --loglevel=error; npm --prefix reviewer ci --no-audit --no-fund --loglevel=error
fi

status=0
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

# Publish the build of main (review changes go live only after the PR is merged and the next run builds it).
if [[ -n "${PUBLISH_DIR:-}" && -d dist ]]; then
  log "publish dist/ -> $PUBLISH_DIR"; rsync -a --delete dist/ "$PUBLISH_DIR"/
fi
log "done (status $status)"
exit $status
