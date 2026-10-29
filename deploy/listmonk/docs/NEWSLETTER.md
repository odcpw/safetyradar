# Safety Radar newsletter (Listmonk)

## Architecture

- **Listmonk v6.2.0** (`listmonk/listmonk:v6.2.0`) + **Postgres 17** (`postgres:17-alpine`) on the Hetzner CX43 VPS, in `/srv/listmonk`.
- Containers `listmonk_app` and `listmonk_db` on the dedicated Docker network `listmonk`; named volumes `listmonk_pgdata`, `listmonk_uploads`.
- Listmonk listens only on `127.0.0.1:9100`. Caddy terminates TLS for `news.safetyradar.ch` and reverse-proxies to it (`Caddyfile.snippet`, appended to `/etc/caddy/Caddyfile`).
- Secrets (admin password, DB password) live only in `/srv/listmonk/.env` (root, mode 600). Never committed.
- The host has no `docker compose` plugin, so `run.sh` starts the stack with plain `docker run` and matches `docker-compose.yml`. If you install the compose plugin later, you can run `docker compose up -d` instead.
- **Sending:** Amazon SES over SMTP (not set up yet). Until then the SMTP settings are Listmonk's placeholder defaults. Listmonk requires at least one SMTP block to be enabled, so the placeholder stays enabled and nothing can actually send.
- **Inbound mail:** ImprovMX forwards `info@safetyradar.ch` (not set up yet).
- Lists (public, double opt-in): Safety Radar (Deutsch) = 3, (Français) = 4, (Italiano) = 5, (English) = 6.
- Settings: root URL `https://news.safetyradar.ch`, from address `Safety Radar <info@safetyradar.ch>`, opt-in confirmation on. Subscribers can unsubscribe, export their data, and wipe their data. The "Powered by listmonk" footer is removed from the templates and hidden on public pages with custom CSS.
- **Backup:** `listmonk-backup.timer` runs daily at 02:45 Europe/Zurich. It writes a `pg_dump` from `docker exec listmonk_db` to `/srv/listmonk/backups` and keeps 14 days. It is separate from `safetyradar-backup.timer`.

## DNS still to add

| Name | Type | Value |
|---|---|---|
| news.safetyradar.ch | A | 116.203.99.44 |
| news.safetyradar.ch | AAAA | 2a01:4f8:1c18:35e0::1 |

These explicit records override the wildcard. Caddy gets the certificate on its own once they resolve.

Still to add for SES and ImprovMX (values come from the SES and ImprovMX consoles):
- SES: 3 DKIM CNAMEs (`<token>._domainkey.safetyradar.ch`), an SPF include `include:amazonses.com`, a custom MAIL FROM domain (MX + TXT), and DMARC `_dmarc.safetyradar.ch TXT "v=DMARC1; p=none; rua=mailto:info@safetyradar.ch"`.
- ImprovMX: `MX 10 mx1.improvmx.com`, `MX 20 mx2.improvmx.com` on `safetyradar.ch`, plus `include:spf.improvmx.com` in the same single SPF TXT record.

## Next steps when SES is ready

1. In Listmonk, go to Settings → SMTP and set host `email-smtp.<region>.amazonaws.com`, port 587, STARTTLS, and the SES SMTP credentials. Then remove the placeholder block.
2. Set up the SES bounce/complaint webhook to Listmonk (Settings → Bounces → SES).
