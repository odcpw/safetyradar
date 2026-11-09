#!/bin/sh
# Schedule (or send now) the week's 4 Safety Radar newsletter drafts created by weekly-issue.mjs.
# Monday 09:00 Europe/Zurich send is driven by the external job (not safetyradar-newsletter-send.timer).
# Manual use: after sanity checks, or with --now.
#   deploy/newsletter/send-week.sh [2026-w46] [--now]
# Default: schedule for Monday 09:00 Europe/Zurich of that week. --now: start sending immediately.
set -eu
cd "$(dirname "$0")/../.."
exec node deploy/newsletter/send-week.mjs "$@"
