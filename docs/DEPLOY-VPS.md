# Moving Safety Radar to a VPS (plan)

Status: **not done.** GitHub Pages (`.github/workflows/pages.yml`) remains the live host. The VPS path is an alternative; both can run in parallel until DNS is switched.

## What runs where

| Part | Today | On the VPS |
|---|---|---|
| Fetch + LLM classify/draft (`npm run update`) | Assistant box, 07:00 weekdays | systemd timer `deploy/systemd/safetyradar-update.timer` (or `deploy/cron.example`, or `docker compose run --rm pipeline`) |
| Email intake (police newsletters, job alerts) | Assistant reads odcpw@mail.grokbot.com | see "Email intake" – stays with the reviewer at first |
| Editorial review (`docs/EDITORIAL.md`) | Assistant, then commit + push | **stays human/LLM**; reviewer edits JSON, commits, pushes |
| Build | Box + GitHub Actions | VPS after each `update` and after `git pull` |
| Hosting | GitHub Pages, `public/CNAME` | Caddy (`deploy/caddy/Caddyfile`) or nginx + certbot (`deploy/nginx/safetyradar.conf`) |

## Requirements
- Any small Linux VPS: Debian 12 / Ubuntu 24.04, 1 vCPU, 1 GB RAM (2 GB recommended for `astro build`), 10 GB disk, Swiss/EU location.
- Node 20 (`.nvmrc`; `engines` >=20 <23), git, rsync, `poppler-utils` (`pdftotext` for ruling PDFs), Caddy 2 or nginx+certbot. Or just Docker.
- Outbound HTTPS to the sources; inbound 80/443.

## Steps
1. `adduser --system --group --home /opt/safetyradar safetyradar`; `git clone https://github.com/odcpw/safetyradar /opt/safetyradar`.
2. Install Node 20 (NodeSource or nvm), `apt install git rsync poppler-utils caddy`.
3. `cp .env.example .env`, fill `OPENAI_API_KEY` (chmod 600, owner safetyradar). Keep `NOINDEX=1` until go-live.
4. Optional: copy pipeline state from the current box so nothing is re-labelled: `data/queue.json`, `data/jobs-queue.json`,
   `data/llm-usage.jsonl`, `data/drafts/`, `data/cache/` (all gitignored). Without them the first run re-queues the 180-day window and
   re-classifies within the USD 0.50/run cap; published entries are still deduped.
5. `npm ci && npm run build`; `mkdir -p /var/www/safetyradar && rsync -a --delete dist/ /var/www/safetyradar/`.
6. Caddy: copy `deploy/caddy/Caddyfile` to `/etc/caddy/Caddyfile`, change `root` to `/var/www/safetyradar`, `systemctl reload caddy`.
   Test before DNS: `curl --resolve safetyradar.ch:443:<VPS-IP> https://safetyradar.ch/` (certificate issues only after DNS points to the VPS;
   test on :80 or with a temporary hostname such as `vps.safetyradar.ch` first).
7. systemd: copy `deploy/systemd/*` to `/etc/systemd/system/`, `systemctl daemon-reload && systemctl enable --now safetyradar-update.timer`.
   Check `systemctl list-timers`, `journalctl -u safetyradar-update`.
8. Pushing from the VPS (only if the review moves there): deploy key with write access for this repo, git identity
   `odcpw <odcpw@users.noreply.github.com>`. Otherwise the VPS only pulls; reviewer pushes from elsewhere; a webhook or the timer pulls+builds.

## Email intake on the VPS (options)
- A. Keep as is: reviewer reads odcpw@mail.grokbot.com (plus-tags), writes entries. Simplest; recommended first.
- B. Script pulls mail via the inbox provider's API (AgentMail) with an API key in `.env`, stores only extracted links/titles in the
  queue (never full bodies – personal data), and adds them to `data/review.md`. Not implemented.
- C. Own mailbox (IMAP) on a domain address, e.g. intake@safetyradar.ch – needs MX records at Hostpoint and re-subscribing all newsletters.
Emails are untrusted input in every option.

## DNS at Hostpoint (later, owner)
Currently apex A records → GitHub Pages (185.199.108–111.153), `www` CNAME → odcpw.github.io.
Switch: lower TTL to 300 a day before; set `A safetyradar.ch → <VPS IPv4>`, `AAAA → <VPS IPv6>`, `www` CNAME → `safetyradar.ch`;
Caddy gets certificates on first request. Then remove the custom domain in GitHub Pages settings (or keep the workflow building as backup).

## Rollback to GitHub Pages
Restore the GitHub A records (185.199.108.153, .109, .110, .111) and `www` CNAME `odcpw.github.io`, re-add the custom domain
`safetyradar.ch` in repo Settings → Pages (`public/CNAME` is still in the repo), re-run the Pages workflow. Stop the VPS timer if the VPS pushes.

## Known open issues (2026-10-28)
- police-ti feed (www4.ti.ch) ECONNRESET two days running (TLS reset from the box; retest from the VPS).
- ZH, SZ, BS, SG police newsletters subscribed but not yet arriving.
- jobscout24 job-alert confirmation pending.

## Owner decisions before the move
- VPS provider/OS/size and location; who has root.
- Caddy vs nginx, Docker vs host install.
- Does the review stay with the assistant (push from outside) or move to the VPS (deploy key with write access)?
- Email intake option A/B/C.
- When to drop `NOINDEX=1` and fill the legal TODOs (imprint/privacy).
- Keep GitHub Pages as permanent fallback or disable it.
