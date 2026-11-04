#!/bin/sh
# Schedule (or send now) the week's 4 Safety Radar newsletter drafts created by weekly-issue.mjs.
# Run only after Oliver approved the preview.
#   deploy/newsletter/send-week.sh [2026-w45] [--now]
# Default: schedule for Thursday 15:00 Europe/Zurich of that week. --now: start sending immediately.
set -eu
cd "$(dirname "$0")/../.."
exec node deploy/newsletter/send-week.mjs "$@"
