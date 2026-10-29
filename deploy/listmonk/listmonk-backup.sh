#!/bin/sh
# Daily pg_dump of the Listmonk DB, keeps 14 days.
set -eu
D=/srv/listmonk/backups
mkdir -p "$D"; chmod 700 "$D"
F="$D/listmonk-$(date +%Y%m%d-%H%M%S).sql.gz"
docker exec listmonk_db pg_dump -U listmonk listmonk | gzip > "$F.tmp"
mv "$F.tmp" "$F"; chmod 600 "$F"
find "$D" -name 'listmonk-*.sql.gz' -mtime +13 -delete
