#!/bin/sh
# Builds /srv/listmonk/overrides: upstream listmonk v6.2.0 static + i18n files,
# overlaid with the Safety Radar files in this directory. Then recreate listmonk_app
# (docker rm -f listmonk_app && /srv/listmonk/run.sh).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DEST=${1:-/srv/listmonk/overrides}
TMP=$(mktemp -d)
git clone -q --depth 1 -b v6.2.0 https://github.com/knadh/listmonk "$TMP/src"
mkdir -p "$DEST"
rm -rf "$DEST/static" "$DEST/i18n"
cp -r "$TMP/src/static" "$DEST/static"
cp -r "$TMP/src/i18n" "$DEST/i18n"
cp -r "$HERE/static/." "$DEST/static/"
cp -r "$HERE/i18n/." "$DEST/i18n/"
rm -rf "$TMP"
echo "overrides installed in $DEST"
