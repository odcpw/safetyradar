# Moving Safety Radar to a VPS (plan)

Status: **prepared, not deployed** (branch `vps-runner`). GitHub Pages (`.github/workflows/pages.yml`) remains the live host. The VPS path is an alternative; both can run in parallel until DNS is switched.

## Daily flow on the VPS (`deploy/run-daily.sh`)
```
systemd timer 07:00 Europe/Zurich (Mon–Fri) → deploy/run-daily.sh   (flock: never two runs at once)
  1. git pull main, npm ci (root + reviewer/)
  2. Stage 1  npm run update            fetch RSS/Bing/entscheidsuche/jobs, gpt-6-luna classify/draft (≤ USD 0.50/run)
                                        → data/review.md, data/drafts/rulings/, data/queue.json, build of main
  3. Intake   scripts/email-intake.mjs  AgentMail API → data/inbox/*.json (untrusted, gitignored; state data/inbox/.state.json)
  4. Stage 2  reviewer/ (Pi Durable)    agent with house rules (docs/EDITORIAL.md) edits data/{accidents,rulings,jobs}.json in a
                                        git worktree on branch review/YYYY-MM-DD from origin/main; host validates + builds,
                                        commits, pushes, opens a PR (≤ USD 1.00/run, ≤ USD 3.00/day)
  5. Publish  rsync dist/ → /var/www/safetyradar (main only; review changes go live after the owner merges the PR)
```
GitHub Pages (`.github/workflows/pages.yml`) is unchanged and keeps deploying `main` until DNS moves.

| Part | Where | Notes |
|---|---|---|
| Stage 1 | `npm run update` | unchanged |
| E-mail intake | `scripts/email-intake.mjs` | needs `AGENTMAIL_API_KEY`; without it the step is skipped. Stores subject + plain text only (no attachments), prunes after 21 days. Test: `npm test` (synthetic fixture). |
| Reviewer | `reviewer/` (`npm run review -- [--dry-run] [--date=YYYY-MM-DD]`) | Node ≥ 22.19 (pi-durable 1.4.0 needs `node:sqlite`). Model `gpt-6.1-sol` (USD 2.00 in / 0.10 cached / 10.00 out per 1M, developers.openai.com/api/docs/pricing, 2026-10-28). |
| Validation | `scripts/validate-data.mjs` (`npm run validate`) | schema + house-rule checks; the reviewer and the host both run it before a PR. |
| Hosting | Caddy (`deploy/caddy/Caddyfile`) or nginx | as before |

### Reviewer details
- **Tools (only these):** `list_inputs`, `read_file` (repo files except `.env*`, `.git`, `node_modules`, state, keys), `fetch_url`
  (public http(s) only, private/metadata IPs blocked, robots.txt respected, 5 MB, PDFs via `pdftotext`), `find_entries`/`get_entry`,
  `upsert_entry`/`add_source`/`remove_entry` (only `data/accidents.json`, `rulings.json`, `jobs.json`), `run_checks` (validation + build).
  No shell, no git: commits, pushes and the PR are done by the host code after its own validation/build.
- **Prompt:** `docs/EDITORIAL.md` verbatim + operating rules (`reviewer/src/prompt.ts`). Mail, web pages, drafts are untrusted; the prompt
  forbids following instructions in them.
- **Crash safety:** the conversation is stored in `reviewer/state/review-<date>.sqlite`. Re-running the same day reopens it and
  `harness.resume()` continues where it stopped (tested: SIGKILL mid-run, restart finished the run and opened the PR). A finished day is
  recorded in `reviewer/state/run-<date>.json` and is not repeated.
- **Cost caps:** spend is read from the harness after every step and priced with `reviewer/src/cost.ts`; at the cap minus a safety margin the
  agent's tools are blocked and the run is aborted. Daily total across runs (`REVIEW_DAILY_MAX_USD`) from `reviewer/state/usage-*.json`;
  every run is also appended to `data/llm-usage.jsonl`.
- **Outputs:** `reviewer/state/review-<date>.diff` and `.md` (PR body + agent answer). `--dry-run` writes only these (detached worktree,
  no branch, no push). No PR when nothing changed, the run did not finish, or checks failed.
- **Open review PRs** are listed to the agent so it does not re-add items that are waiting for the owner's merge.

## Hetzner setup (Debian 12/13 or Ubuntu 24.04)
1. **Instance:** a small shared-vCPU Cloud server – Cost-Optimized/Regular Performance x86 (CX/CPX line) or Arm (CAX line) with 2 vCPU,
   4 GB RAM, 40 GB disk; `astro build` + reviewer fit easily. Location Falkenstein or Nuremberg (closest to CH). Hetzner listed
   "from € 5.99 / € 6.49 per month excl. VAT" on 2026-10-28 (hetzner.com/cloud) – check the console for current names and prices.
   Add your SSH key at creation; enable backups (or snapshots) if wanted.
2. **Firewall (Hetzner Cloud Firewall, plus `ufw` on the host):** inbound 22/tcp (ideally only from your IP), 80/tcp, 443/tcp; ICMP;
   everything else denied. Outbound open (sources, OpenAI, AgentMail, GitHub).
3. **Base hardening:** `apt install unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades` (security updates daily);
   `PasswordAuthentication no` and `PermitRootLogin prohibit-password` in sshd; `timedatectl set-timezone Europe/Zurich` (the timer uses
   an explicit zone anyway); optional `fail2ban`.
4. **Packages:** Node 22 LTS (NodeSource `setup_22.x`), `apt install git rsync poppler-utils caddy` (Caddy apt repo), GitHub CLI
   (`gh`, cli.github.com apt repo). Or Docker only (see below).
5. **User + checkout:** `adduser --system --group --home /opt/safetyradar safetyradar`;
   `sudo -u safetyradar git clone https://github.com/odcpw/safetyradar /opt/safetyradar`; `mkdir -p /var/www/safetyradar && chown safetyradar /var/www/safetyradar`.
6. **Secrets – only in `/opt/safetyradar/.env`** (`cp .env.example .env`, `chown safetyradar: .env && chmod 600 .env`, never committed,
   `.gitignore` covers it): `OPENAI_API_KEY`, `AGENTMAIL_API_KEY`, `GH_TOKEN`. Keep `NOINDEX=1` until go-live. Back the file up offline.
7. **GitHub write access for review PRs** (pick one; owner decision):
   - *Recommended:* a **fine-grained PAT** limited to `odcpw/safetyradar` with *Contents: read/write* and *Pull requests: read/write*,
     as `GH_TOKEN` in `.env`; then once `sudo -u safetyradar gh auth setup-git` so `git push` uses it. Branch protection on `main`
     (require PR) keeps the bot from pushing to `main` directly.
   - *Deploy key:* `ssh-keygen -t ed25519 -f /opt/safetyradar/.ssh/id_ed25519` (user safetyradar), add the public key in repo Settings →
     Deploy keys **with write access**, `git remote set-url origin git@github.com:odcpw/safetyradar.git`. A deploy key can push branches
     but **cannot open PRs**, so `GH_TOKEN` (PRs only) is still needed – or open PRs by hand from the pushed `review/*` branch.
8. **Copy working state** from the current box so stage 1 doesn't re-label everything: `data/queue.json`, `data/jobs-queue.json`,
   `data/llm-usage.jsonl`, `data/drafts/`, `data/cache/` (all gitignored). Then `npm ci && npm --prefix reviewer ci`.
9. **First runs:** `sudo -u safetyradar env REVIEW_ARGS=--dry-run deploy/run-daily.sh` → read `reviewer/state/review-<date>.diff`; then a
   normal run. Caddy: copy `deploy/caddy/Caddyfile` to `/etc/caddy/Caddyfile`, set `root` to `/var/www/safetyradar`, reload.
10. **systemd:** `cp deploy/systemd/safetyradar-update.{service,timer} /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now safetyradar-update.timer`;
    check `systemctl list-timers`, `journalctl -u safetyradar-update`.

**Docker variant:** `docker compose build && docker compose run --rm pipeline` (mounts the checkout at `/app`; image = Node 22, git, gh,
poppler). Trigger it from a host timer/cron instead of `ExecStart`. Put an SSH deploy key in `deploy/ssh/` (gitignored) only if you use SSH.

### Moving the daily review off the assistant box
Until the VPS runs, the existing 07:00 assistant job keeps working as before. When the VPS timer is enabled, stop the assistant's
daily routine (otherwise both edit the same items). The VPS reviewer opens PRs instead of pushing to `main`; the owner merges.

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
- Reviewer on the VPS: PAT vs deploy key (+PAT for PRs); merge policy for review PRs (owner merges daily?).
- E-mail intake: option B implemented (AgentMail API, needs an API key).
- When to drop `NOINDEX=1` and fill the legal TODOs (imprint/privacy).
- Keep GitHub Pages as permanent fallback or disable it.
