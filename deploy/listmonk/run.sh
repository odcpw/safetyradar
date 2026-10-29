#!/bin/sh
# cx43 has no docker compose plugin; this script is the plain-docker equivalent of docker-compose.yml.
set -eu
cd /srv/listmonk
set -a; . ./.env; set +a
docker network inspect listmonk >/dev/null 2>&1 || docker network create listmonk >/dev/null
docker volume create listmonk_pgdata >/dev/null
docker volume create listmonk_uploads >/dev/null
if ! docker inspect listmonk_db >/dev/null 2>&1; then
  docker run -d --name listmonk_db --restart unless-stopped --network listmonk \
    -e POSTGRES_USER=listmonk -e POSTGRES_DB=listmonk -e POSTGRES_PASSWORD="$LISTMONK_DB_PASSWORD" -e TZ=Europe/Zurich \
    -v listmonk_pgdata:/var/lib/postgresql/data \
    --health-cmd "pg_isready -U listmonk" --health-interval 10s postgres:17-alpine >/dev/null
fi
i=0; until docker exec listmonk_db pg_isready -U listmonk >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 30 ] && exit 1; sleep 2; done
if ! docker inspect listmonk_app >/dev/null 2>&1; then
  docker run -d --name listmonk_app --restart unless-stopped --network listmonk \
    -p 127.0.0.1:9100:9000 \
    -e TZ=Europe/Zurich -e LISTMONK_app__address=0.0.0.0:9000 \
    -e LISTMONK_db__host=listmonk_db -e LISTMONK_db__port=5432 -e LISTMONK_db__user=listmonk \
    -e LISTMONK_db__database=listmonk -e LISTMONK_db__password="$LISTMONK_DB_PASSWORD" -e LISTMONK_db__ssl_mode=disable \
    -e LISTMONK_ADMIN_USER="$LISTMONK_ADMIN_USER" -e LISTMONK_ADMIN_PASSWORD="$LISTMONK_ADMIN_PASSWORD" \
    -v listmonk_uploads:/listmonk/uploads \
    listmonk/listmonk:v6.2.0 sh -c "./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && ./listmonk --config ''" >/dev/null
fi
