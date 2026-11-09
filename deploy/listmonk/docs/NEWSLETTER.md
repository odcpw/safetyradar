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

## Bounce and complaint handling (Amazon SES)

- SES sends bounce and complaint notifications to an SNS topic in `eu-central-1`.
- The topic has an HTTPS subscription to `https://news.safetyradar.ch/webhooks/service/ses`. Caddy proxies it to Listmonk, which confirms the SNS subscription automatically.
- Listmonk settings (Settings → Bounces): `bounce.enabled = true`, `bounce.webhooks_enabled = true`, `bounce.ses_enabled = true`.
- Actions: soft bounce, count 2 → none; hard bounce, count 1 → blocklist; complaint, count 1 → blocklist.
- Note: `/api/settings` returns passwords masked. When you PUT settings back, send the SMTP password as an empty string to keep the stored one, or send the real value. If you send the mask back, it overwrites the stored password.

## Branding and language overrides

- Listmonk runs with `--static-dir /listmonk/overrides/static --i18n-dir /listmonk/overrides/i18n`; `/srv/listmonk/overrides` is mounted read-only (see `run.sh` / `docker-compose.yml`).
- `deploy/listmonk/overrides/` holds only the changed files; `overrides/install.sh` rebuilds the full directory from upstream v6.2.0 plus these files. After changes: `docker rm -f listmonk_app && /srv/listmonk/run.sh`.
- Changes: "Powered by listmonk" removed from emails (`base.html`) and public pages (`index.html`, footer links to safetyradar.ch); listmonk logo/favicon replaced; opt-in email (`subscriber-optin.html`) is DE/FR/IT/EN with no name greeting.
- `i18n/en.json` (app language is `en`): opt-in subject is "Bitte bestätigen / Confirmez / Confermate / Please confirm – Safety Radar"; all `public.*` strings are "DE / FR / IT / EN", generated from upstream de/fr/it/en.json.
- Don't add "if you did not sign up, ignore this e-mail" type wording to the opt-in mail: the grokbot test inbox silently drops it.
- No settings were changed for this; don't PUT `/api/settings` (masked passwords).

## Tracking and newsletter links
- Open tracking: `{{ TrackView }}` removed from the default campaign template (id 1) on 2026-11-04; the archive template never had it. Don't re-add it (privacy page says there is no open tracking). The unused "Sample visual template" still contains it – don't use that template.
- Every link to safetyradar.ch in an issue must carry `utm_source=newsletter&utm_medium=email&utm_campaign=<issue>` (issue = ISO week, e.g. `2026-w45`), optionally `utm_content=a|b` for A/B variants.
- Helper: `scripts/lib/utm.mjs` – `issueId(date)`, `tagUrl(url, {campaign, content})`, `tagHtml(html, {campaign, content})`; CLI `node scripts/lib/utm.mjs issue.html 2026-w45 a > tagged.html`. Only safetyradar.ch links are changed. Tests: `test/utm.test.mjs`.
- A/B: send variant A with `content: 'a'` and B with `content: 'b'` (e.g. two campaigns to split lists); the weekly stats break clicks down by campaign and content. No test is set up yet.

## Aggregate website/newsletter measurement
- See `deploy/analytics/README.md`: cookieless first-party cohorts, no email/reader linkage, active-reading samples and separate submission/accepted/confirmed response counts.
- Caddy now writes `safetyradar-pages.log`: known public HTML paths only, no raw query/referrer/IP. Closed historical logs are sanitized and expire after the existing 56-day policy (weekly cleanup).
- `/srv/safetyradar/stats/analytics-latest.{json,txt}` is refreshed every minute; existing weekly request summaries remain separate. Neither metric is a unique-reader or unique-click count.
- Internal browser checks use `sr_test=1`; event checks use `test:true`. No measurement endpoint submits an email or sends a campaign.

## Weekly issue (drafts only) and sending
- `deploy/newsletter/weekly-issue.mjs` builds one issue per language from the VPS data: everything added since the previous Monday 08:00 Europe/Zurich (git diff of `data/*.json` against the last data commit before then). Rulings, accidents (title + first sentence of the curated lesson, or else `facts.what` / `facts.injuries`, linked to the site page) and a "new jobs" count in **AS/GS** wording (never HSE) with the top 5. "Quiet week" text when there are no new accidents/rulings. No LLM; links tagged via `scripts/lib/utm.mjs` (`utm_campaign=<yyyy>-w<nn>`).
- Saves Listmonk campaign DRAFTS named `safetyradar-<issue>-<lang>` on lists 3 DE / 4 FR / 5 IT / 6 EN, template 1 (no tracking pixel). Re-running in the same week updates those drafts (only while status is draft). Never sends or schedules.
- Subject: short factual counts only, zero counts skipped, never an item title (no fatal/death wording, no names), e.g. DE "Safety Radar KW 45: 4 Arbeitsunfälle, 18 neue Stellen", FR "Safety Radar semaine 45 : 4 accidents, 18 offres d’emploi"; "ruhige Woche" etc. only if everything is 0.
- `--preview=oliver@decaro.ch` test-sends the DE and EN drafts (Listmonk test-send; the address is kept as a Listmonk subscriber with no lists so it never gets real campaigns). Summary: `/srv/safetyradar/newsletter/<issue>.json`.
- Timer: `safetyradar-newsletter.timer`, Mondays **08:00** Europe/Zurich — builds DE/FR/IT/EN Listmonk drafts and test-sends DE+EN previews to oliver@decaro.ch (never the list). The Monday **09:00** list send is owned by the external job (not a VPS timer). Dry run: `node deploy/newsletter/weekly-issue.mjs --dry-run --html=/tmp/issue.html`.
- Send: **not** via a VPS systemd timer. The Monday **09:00** Europe/Zurich job (outside this host) sanity-checks the issue and runs `deploy/newsletter/send-week.sh` itself. Do **not** enable `safetyradar-newsletter-send.timer` on cx43 — it would double-send and skip those checks. Unit files remain under `deploy/systemd/` for reference only (`safetyradar-newsletter-send.{timer,service}`). Manual: `/srv/safetyradar/app/deploy/newsletter/send-week.sh [2026-w46] [--now]`.
- Optional override when migrating cadence: `--since=YYYY-MM-DDTHH:MM` (Europe/Zurich) on weekly-issue.

### Date rules (2026-11-04)
Items must be new since the previous issue AND recent by when they happened; items without a valid date are dropped.
- Accidents: event date within the previous Monday minus 7 days grace up to today (~14 days).
- Rulings: by release, never by decision date. `published` (the date the source shows: bger.ch "Neue Entscheide" day list, or the news article's publication date) within the previous Monday minus 23 days up to today (~30 days). If `published` is null, the separate fallback `firstSeen` (day the pipeline first fetched the ruling) is used. Neither -> dropped. The email shows "publiziert dd.mm.yyyy" (or "erfasst" for the fallback) plus the decision date.
- How `published` is filled: `scripts/lib/published.mjs` (used by `draft-rulings.mjs`; news items also carry the feed pubDate from `fetch-sources.mjs`). Court portals (entscheidsuche, cantonal portals) show no release date -> null. The reviewer keeps these fields; `firstSeen` is set once on first publish.
- Jobs: `datePosted` since the previous Monday (jobs.json only holds live postings).
- Accidents and rulings show their date (dd.mm.yyyy) in the email. Dropped items are listed in the summary JSON (`dropped`).
