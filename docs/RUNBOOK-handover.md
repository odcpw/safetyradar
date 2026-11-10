# Operate Safety Radar from cx43

Checked on 10 November 2026, Europe/Zurich. This is the repository handover for the cx43 VPS. Run all production commands on cx43, not on the bot box.

## Start here

Keep the work on cx43. Use the bot to choose cases, check facts, request approval, start VPS commands, and report results. Do not move production secrets or subscriber data into chat.

The VPS renders Reels and runs the Meta helpers below. The existing ad generator, its parameters, and approved outputs are archived on the VPS. A fresh ad render was not tested during this setup. The Meta token is installed and read-only API requests succeed. Helpers use only the Python standard library, ffprobe, and the shared `scripts/meta_common.py`. Playwright is needed only for rendering. There is no automatic case picker or standing Instagram approval.

No Reel, ad, budget, or campaign status was changed during this setup. The newsletter send timer remains disabled.

## Meta login and API access rules

Agents never log in to Facebook or Meta from the box browser. All Meta data comes from token-based scripts on the VPS only. Any Meta login, including account confirmation at developers.facebook.com, is done by the owner from his own laptop.

Do not call the Graph API from the box, even with the saved token. Browser logins and API calls from changing cloud IPs on the box were the likely trigger for the 10 November 2026 "API access blocked" incident. If a snapshot or VPS script reports `meta_api_health: BLOCKED`, ask the owner to confirm the developer account from his laptop. Do not try to fix it by logging in from the box.


## Read the current status

The primary status file is written on the VPS by a read-only snapshot. It does not log in to Facebook and it makes no Meta writes. Read it there:

```sh
cat /srv/safetyradar/stats/status-latest.txt
```

The JSON form is `/srv/safetyradar/stats/status-latest.json`. A dated copy for the current Europe/Zurich day is updated on each run under `/srv/safetyradar/stats/status-archive/status-YYYY-MM-DD.txt`.

`safetyradar-status.timer` runs the snapshot every six hours at 00:00, 06:00, 12:00 and 18:00 Europe/Zurich. To refresh it now:

```sh
/srv/safetyradar/venv-social/bin/python /srv/safetyradar/app/scripts/ops/status_snapshot.py
```

The file starts with `meta_api_health: OK`, or with `BLOCKED`, `TOKEN`, or `PERMISSION`, plus the sanitized error message and `fbtrace_id`. Those unhealthy results are also appended to `/srv/safetyradar/ops/journal.jsonl`. The snapshot includes per-ad and campaign spend, impressions, clicks, link clicks, CTR, and CPC in CHF for today, yesterday, and campaign lifetime; campaign and ad `effective_status` and review state; Instagram followers and the last five media, with plays, reach, and likes when the insights permission allows; Facebook Page followers/fan count and Page insights (page views, media views, unique media views, post engagements) for today, yesterday, last 7 days and last 28 days, using v21.0 metrics that `pages_read_engagement` can read; cookieless per-page website analytics for today, last 7 days and retained all-time, split by campaign cohort, with a dedicated `/de/` homepage view since the 10 November 2026 retarget; and Listmonk subscriber counts (total, confirmed, created in the last seven days). Instagram insights and unsupported or deprecated Page metrics are omitted cleanly when the permission or metric is missing. It does not retry a failed Meta call in a loop. Instagram timestamps are shown in Europe/Zurich.

`scripts/ads/ads_report.py` remains available on the VPS for a narrower date-range check. Do not run it, or any other Meta script, from the box.


## Run the social and ads helpers

Run from `/srv/safetyradar/app` with `/srv/safetyradar/venv-social/bin/python`. All three helpers accept `--token-file`; its default is the root-only VPS path. None prints the token or raw API errors. Mutating helpers require either `--dry-run` or `--execute`. An execute flag is not owner approval.

Read a CHF report. This command makes GET requests only:

```sh
/srv/safetyradar/venv-social/bin/python scripts/ads/ads_report.py --since 2026-11-09 --until 2026-11-09
```

Add `--dry-run` to validate the dates and inspect the request without network calls. Reporting follows pagination, checks the account currency, computes link CPC and CTR, and avoids summing per-ad reach.

Validate an approved Reel without publishing or exposing its file:

```sh
/srv/safetyradar/venv-social/bin/python scripts/social/publish_reel.py \
    /srv/safetyradar/social/2026-11-09-vps-test-v2/reel1_accident.mp4 \
    /srv/safetyradar/social/2026-11-09-vps-test-v2/reel1_caption.txt \
    --dry-run --check-remote
```

`--check-remote` adds GET-only recent-caption checks. Without it, dry-run is offline. Dry-run creates no locks, journals, or public files. The publisher enforces 1080 by 1920 H.264 yuv420p and explicit limited-range BT.709 metadata by default. The narrowly scoped `--approved-video-sha256 <64-hex-hash>` option pins an already approved original byte-for-byte and permits only missing primaries/transfer tags; it does not allow incorrect tags, dimensions, range, matrix or codec. Never substitute a re-render for an approved original unless that substitution was approved. After specific approval, replace `--dry-run` with `--execute --approval-ref <owner-message-id>`. Keep the same inputs and the default state directory on every retry. It saves and prints the published permalink, or returns the existing matching media rather than republishing.

Prepare the payload for a PAUSED ad, without uploading or creating anything:

```sh
/srv/safetyradar/venv-social/bin/python scripts/ads/ads_create.py \
    /srv/safetyradar/social/ads-source/out/A_9x16.mp4 \
    --thumbnail /srv/safetyradar/social/ads-source/out/A_9x16_mid.png \
    --message-file /srv/safetyradar/social/ad-message.txt \
    --name 'Safety Radar reviewed A' --variant a --utm-campaign de-2026-w46 \
    --dry-run --check-remote
```

Create `ad-message.txt` privately with the reviewed German primary text. `--check-remote` reads the CHF account and existing campaign/ad-set identity. It does not write. After approval of that preparation, `--execute --approval-ref <owner-message-id>` uploads the video and image, creates the creative with UTMs, and creates an ad with literal `status=PAUSED`. The account, ad set, destination, Page, and Instagram IDs are fixed to the approved setup. There is no activation, budget, targeting, or campaign-creation option. Buffered video uploads are limited to 100 MiB. Thumbnails are limited to 8 MiB.

The default journal directory is `/srv/safetyradar/social/state`, outside Git. Journals and locks are owner-only. Each operation has a content-derived identity. Mutating work uses an exclusive channel lock, durable atomic checkpoints, and one attempt per POST. A lost write response remains pending. The helper reconciles known IDs or exact fingerprinted remote names where possible, otherwise stops rather than creating a duplicate. Do not delete or edit a journal to force a retry.

All external write paths remain untested against live Meta during setup. Only offline fakes, dry-runs, and real GET requests were used. For the first approved write, inspect its journal and the returned Meta object before scheduling the next one.

Verification on 9 November 2026 passed 28 offline tests on cx43. Both publisher dry-runs passed input and metadata validation. The read-only ads report returned the three existing ads in CHF. Ad preparation with `--dry-run --check-remote` confirmed the existing account/ad set and literal PAUSED payload. No production journal or public MP4 was created.

The code-10 diagnosis was resolved on 10 November 2026: `17841429970165089` was the Page-backed ad identity, not the real organic publishing user. The first approved attempt reached `POST /17841429970165089/media` and failed with HTTP 400/code 10; its durable state has `phase=failed`, no container ID and no media ID. It did not reach `media_publish`. Keep that failed record; do not delete it or clear it to force a retry.

The correct organic user is `17841441257076577`: `GET /<id>?fields=username` returns `safetyradarch`, its recent-media read works, and `content_publishing_limit` returns a valid quota (100 posts per rolling 86,400 seconds). Token introspection confirms `instagram_content_publish`, `instagram_basic`, `pages_read_engagement` and `pages_show_list`. Granular scopes returned no target IDs; do not invent an asset list from that omission. `/me/accounts` currently returns an empty list. These do not negate the successful direct business-user reads. No missing permission was demonstrated for the real organic account. The token's data-access expiry is 7 February 2027 at 14:53:59 Europe/Zurich; `expires_at=0` does not remove that separate access expiry.

Normal publishing still fails closed on recent-media errors. Only when the owner has accepted agent-only marker/journal protection for the specific post may `--allow-marker-guard --approval-ref <specific-approval>` handle code 10 from that GET. Other API errors never fall back. Under the global publishing lock the helper checks `/srv/safetyradar/social/published/*.json`, all `state/reel-*.json` journals and `/srv/safetyradar/ops/journal.jsonl`. A published record blocks another publication even across account-ID corrections or a different render with the same approval or caption hash. Unknown writes remain blocked. A definitive failed container-creation request with no container/media ID is preserved and is not a published marker.

The Thursday 12 November approved Urteil routine must call the updated VPS publisher and therefore target `17841441257076577`. Remove any hard-coded organic target of `17841429970165089` from its instructions. Do not change the live ads: their Page-backed identity is intentionally kept separate in `AD_IG_USER_ID`.

Run the offline behavior tests on cx43:

```sh
cd /srv/safetyradar/app
PYTHONDONTWRITEBYTECODE=1 /srv/safetyradar/venv-social/bin/python -m unittest discover -s test -p social_tools_test.py -v
```

The fake transports test dry-run isolation, duplicate checks, uncertain-write refusal, private state, locks, token-error redaction, PAUSED-only payloads, and link metrics. They never call Meta.

## Current ad landing page

The three live ads now click through to `https://safetyradar.ch/de/`, the German homepage. The owner approved this landing-only change on 10 November 2026. The decision baseline was about 2 seconds active time on the signup page and no observed signups after 36 ad visits. These are aggregate browser observations, not unique people or proof that the homepage will convert better.

Only the click-through destination changed. The videos, thumbnails, primary text, headline, description, SIGN_UP CTA, Page and Instagram identities, UTM tags, and creative enhancement opt-outs stayed the same. The unchanged videos still show the existing newsletter signup capture. The existing ad IDs, ACTIVE configured status, CHF 9 daily ad-set budget, audience, and campaign stayed unchanged. No new ads were created.

Meta creatives are immutable. Each ad now references a new creative. A creative-pointer update can put an ACTIVE-configured ad into Meta processing or review. Do not change its status or budget to force delivery. Read `effective_status` and review feedback, and report the actual state.

See [the operations journal](ops-journal.md) for the old/new creative IDs, timestamped read-backs, and the test-only preflight. The guarded `ads_create.py` helper now uses the homepage for future specifically approved PAUSED preparations. It still cannot activate ads or change budgets. The narrowly scoped one-off live replacement is archived at `/srv/safetyradar/social/retarget-homepage-2026-11-10/retarget.py`; it is not a standing authorization or a general ad-edit command.

## Locate the services

- Host: Hetzner cx43, Ubuntu 26.04.1 LTS. The host clock uses UTC. Use Europe/Zurich for every schedule and user-facing time.
- GitHub code source: `https://github.com/odcpw/safetyradar`, branch `main`.
- App checkout: `/srv/safetyradar/app`.
- Current VPS-only data commit at setup: `653d37a`. Its message says local-only. Never push this commit or its editorial data to GitHub.
- Site: `https://safetyradar.ch`. Caddy serves `/srv/safetyradar/www`, a symlink to an atomic release under `/srv/safetyradar/www.releases`.
- App environment: `/srv/safetyradar/.env`. Do not print its contents. `GIT_PUSH=0` keeps generated data local.
- Daily entry point: `/srv/safetyradar/app/deploy/run-daily.sh`.
- Data: `data/accidents.json`, `data/rulings.json`, and `data/jobs.json` in the VPS checkout.
- Reviewer: `reviewer/`, with local state under `reviewer/state`. Source intake, drafts, and queues are under `data/`.
- Site backups: `/srv/safetyradar/backups`, managed by `safetyradar-backup.timer`.
- Newsletter: Listmonk 6.2.0 and Postgres 17 in `/srv/listmonk`. Containers are `listmonk_app` and `listmonk_db`. Caddy proxies `news.safetyradar.ch` to localhost port 9100.
- Newsletter credentials: `/srv/listmonk/.env`, root-only. Do not dump the file or log API settings.
- Newsletter delivery: Amazon SES, eu-central-1. Double opt-in is required.
- Newsletter drafts and summaries: `/srv/safetyradar/newsletter`.
- Measurement service: `safetyradar-measurement.service`, running `deploy/analytics/server.mjs`.
- Measurement reports: `/srv/safetyradar/stats/analytics-latest.json` and `analytics-latest.txt`. Daily aggregate counters are under `/srv/safetyradar/stats/events`.
- Status snapshot: `/srv/safetyradar/stats/status-latest.txt` and `status-latest.json`, with dated copies in `/srv/safetyradar/stats/status-archive/`. Written by `safetyradar-status.timer`.
- Reel runtime: `/srv/safetyradar/venv-social/bin/python`.
- Persistent approved Inter TTFs: `/srv/safetyradar/fonts/Inter-Regular.ttf` and `Inter-Bold.ttf`.
- Private social output: `/srv/safetyradar/social`. This is not a Caddy document root.
- Existing ad generator and approved creatives: `/srv/safetyradar/social/ads-source`.
- Root-only Meta token: `/srv/safetyradar/.secrets/meta_token`, mode 600. Its parent is mode 700. It is outside the Git tree.

Read `docs/DEPLOY-VPS.md`, `docs/EDITORIAL.md`, `docs/social-reels.md`, `deploy/listmonk/docs/NEWSLETTER.md`, and `deploy/analytics/README.md` for component details. Some older sections describe pre-launch plans. Prefer verified live service configuration and the newer go-live notes.

## Follow the weekly calendar

Every time in this section is Europe/Zurich.

- 00:00, 06:00, 12:00 and 18:00: `safetyradar-status.timer` writes the read-only status snapshot. This is not a replacement for Monday 06:30 `safetyradar-stats.timer`.
- Monday 06:30: `safetyradar-stats.timer` refreshes weekly stats.
- Monday through Friday 07:00: `safetyradar-update.timer` starts the data pipeline. The timer adds up to 120 seconds of random delay.
- Monday 08:00: `safetyradar-newsletter.timer` builds Listmonk drafts and sends the configured owner previews. It does not send to the lists.
- Monday 09:00: the external bot routine checks the issue and calls `deploy/newsletter/send-week.sh`.
- Tuesday 07:00: publish the specifically approved accident Reel.
- Thursday 07:00: publish the specifically approved Urteil Reel.
- Daily 02:30: site backup.
- Daily 02:45: Listmonk database backup.

The current one-off Reel approvals cover Tuesday 10 November and Thursday 12 November 2026. They do not approve future cases. Check the bot's routines before a manual publish. Never add a second publisher for the same slot.

Check schedules with `systemctl list-timers --all`. Confirm the send timer with `systemctl is-enabled safetyradar-newsletter-send.timer` and `systemctl is-active safetyradar-newsletter-send.timer`. The required answers are `disabled` and `inactive`. Do not enable it.

## Pick a case

1. Open the live German page and its linked primary source.
2. Choose a recent accident by event date. Choose a recent ruling by publication date, not decision date. A recent release can concern an older decision.
3. Skip fatal accidents for organic Reels and ad creatives.
4. Check recent Instagram media and the local publication record to avoid repeating the same case.
5. Copy only source-confirmed facts. Never infer injuries from a charge, a fall height, or a sanction.
6. Include an accident lesson only when the published case has a curated lesson from the approved corpus. No lesson means no rule box.
7. For a ruling, copy the offence and legal articles only when the case lists them. Preserve the difference between a lower-court finding, an appeal, a remand, and a final outcome.
8. Verify the day-fine multiplication. Write `180 Tagessätze à CHF 30 (total CHF 5’400), bedingt`, not just a number of day-fines.
9. Save the canonical case URL and source URL beside the draft. Request approval of the specific MP4, caption, and posting slot.

The current renderer includes two hard-coded cases. It is not a live case picker. Re-rendering it without changing its case definitions repeats the existing cases.

## Render the existing Reel design

The existing renderer is `/srv/safetyradar/app/scripts/social/make_reel.py`. It uses Playwright Chromium to capture frames and ffmpeg to encode them. It does not publish.

The VPS has Python 3.14.4, Playwright 1.64.1 in a dedicated environment, its Chromium browser, ffmpeg 8.0.1, and Inter 4.1. The approved static Inter TTFs are in the persistent font directory. The renderer defaults to those fonts and a dated output directory under `/srv/safetyradar/social`. It no longer depends on `/tmp` fonts or writes beside its source.

Render only the existing accident example:

```sh
/srv/safetyradar/venv-social/bin/python scripts/social/make_reel.py \
    --example accident --output-dir /srv/safetyradar/social/manual-test
```

Use `--example urteil` for the existing Urteil. Use `--example all` for both. Use `--font-dir` to override the persistent Inter TTF directory. `--dry-run` validates copy and reports holds without rendering, writing files, or needing Playwright.

To render a new reviewed case without editing code, pass `--case-file /srv/safetyradar/social/case.json` instead of `--example`. The file is one object or a list of objects with this schema:

```json
{
    "outfile": "case.mp4",
    "cover": "case_cover.png",
    "caption_file": "case_caption.txt",
    "type_label": "Unfall",
    "sublabel": "Source-confirmed place and canton",
    "headline": "Source-confirmed German headline",
    "paragraphs": ["First reviewed paragraph", "Second reviewed paragraph"],
    "box": null,
    "caption": "Reviewed factual German caption with newsletter CTA and hashtags"
}
```

These are schema placeholders, not publishable copy. Use `Urteil` and a verified sanction string in `box` when appropriate. Save the source and canonical case URLs beside the JSON. The renderer escapes copy as text. Output filenames must be distinct basenames, not paths. Never replace a previously approved version without review.

The initial test is in `/srv/safetyradar/social/2026-11-09-vps-test`. It revealed missing color-primaries and transfer metadata under ffmpeg 8. The fixed renderer strips inherited JPEG ICC side data, sets explicit BT.709 frame parameters, and also sets the encoder color flags. Fresh test outputs are in `/srv/safetyradar/social/2026-11-09-vps-test-v2`, with MP4, cover, caption, and `timing_report.json`. Neither test publishes anything. ffprobe verified explicit `bt709` color space, primaries, and transfer in both fixed MP4s, with `tv` range, H.264 yuv420p, 1080 by 1920, 30 fps, and AAC stereo at 48 kHz. Durations are 24.53 seconds for the accident and 34.43 seconds for the Urteil. The Urteil timing report exercises overflow at 16 CSS px per second, or 32 output px per second.

Inspect the actual MP4 and cover. Check the entire scroll, the title, the safe areas, the fine total, and the final CTA. Use ffprobe to confirm the encode. A successful render alone does not prove that the case copy is correct.

## Preserve the approved v4 parameters

Use a 1080 by 1920, 9:16 canvas. The browser viewport is 540 by 960 CSS pixels at device scale factor 2.

Keep the `safetyradar.ch` chip and uppercase `UNFALL` or `URTEIL` label pinned. Use whole-paragraph fades. Paragraphs accumulate rather than replace one another. Scroll the article up when it overflows. Keep important copy above the bottom 20 percent safe area. Fade old copy at the top.

Use these CSS sizes:

- Chip: 16 px.
- Type label: 36 px.
- Sublabel: 15 px.
- Headline: 57 px, line height 1.12, maximum width 468 px.
- Paragraph: 24 px, line height 1.38, maximum width 468 px.
- Sanction box: 22 px, line height 1.32.
- End CTA: 32 px.
- End brand: 22 px. End URL: 18 px.
- Footer: 14 px.

Use Inter Regular and Bold. The background is `#14202D`. Accent, chip, type label, and sanction box are `#FFCC00`. Body copy is `#E8EEF5` or white. Muted copy is `#C8D0DA`. The footer is `#8A95A3`.

The animation fades and settles a whole block over 0.45 seconds. Overflow scroll is 16 CSS px per second, which is 32 final-output px per second. The renderer uses a header height constant of 168 CSS px, a content-top constant of 176 CSS px, and a bottom safe boundary of 768 CSS px. Visually review the safe areas rather than relying only on constants.

Use 190 words per minute. This is a conservative house pace for unsolicited German phone video, not a measured German reading average. The research reference is Brysbaert, M. 2019, *How many words do we read per minute? A review and meta-analysis of reading rate*, Journal of Memory and Language 109, 104047, DOI `10.1016/j.jml.2019.104047`. Its English silent non-fiction average is 238 words per minute.

For each block, after the block is fully visible:

```text
hold = max(words * 60 / 190 + 1.0 + 0.35 * number_or_dense_token_count, 1.5)
```

Dense tokens include digit, CHF, Tagessätze, Art., and total tokens as counted by the renderer. Add 2 seconds for a sanction box. Hold the final CTA for at least 2.5 seconds. Do not shorten the reading holds to fit a preset video duration.

Encode with H.264 `libx264`, `yuv420p`, 30 fps, CRF 18, limited-range BT.709 metadata, silent AAC stereo at 48 kHz, and `+faststart`. Extract a 1080 by 1920 PNG cover from a mid-content frame. Preserve the caption as UTF-8 text.

## Write the caption

Start with a short factual German summary. Include the day-fine total when the video shows it. Add a blank line, then:

```text
Jeden Montag die wichtigsten Unfälle, Urteile und AS/GS-Jobs im Newsletter. Link in Bio.
```

Add another blank line and a few relevant hashtags. The existing set includes `#Arbeitssicherheit #Suva #SafetyRadar #ASGS`, with case-specific tags. Use Swiss German spelling with `ss`, never `ß`. Use AS/GS, not HSE.

## Publish only an approved Reel

The API is Meta Graph v21.0. The verified organic Instagram business user for `@safetyradarch` is `17841441257076577`. The different Page-backed ad identity `17841429970165089` is not an organic publishing target. No Facebook Page posting is available because `pages_manage_posts` is absent.

The helper implements the following flow. This describes an approved publish, not permission to execute it now:

1. Take an exclusive publish lock. Bind the job to the approved MP4 checksum, normalized caption checksum, case URL, and posting slot.
2. Read recent media from `GET /17841441257076577/media` with `id,caption,timestamp,permalink,media_type`. Follow paging. Compare normalized full captions and any local recorded case identity. Stop on a match. A recent-caption check alone is not a complete idempotency guarantee.
3. Save a durable pending record outside Git before the first write. Record the container ID as soon as Meta returns it.
4. Copy the MP4 to an unguessable temporary path under the currently served document root. Never copy the token, environment, caption state, or private directory there. Use HTTPS and check that the public file can be fetched.
5. Create a container with `POST /17841441257076577/media`, `media_type=REELS`, `video_url=<temporary HTTPS URL>`, and the approved caption. Use the documented optional cover parameters only when verified for the selected API version.
6. Poll `GET /<container-id>?fields=status_code,status` with a bounded timeout. Publish only after `FINISHED`. Stop on `ERROR` or `EXPIRED`.
7. Recheck duplicate media, then call `POST /17841441257076577/media_publish` with `creation_id=<container-id>` once. Do not repeat that POST if its response is lost.
8. Read the returned media ID and permalink. Save both in the durable record before reporting success.
9. Remove only the temporary file created by this job. Keep private source assets and the durable publication record.

If the publish request times out, its result is unknown. Read recent media and recover the existing result before any retry. Never create another container just because the client lost the response. Keep temporary video available while Meta still needs to fetch it. If a job fails, inspect its container and state before cleanup or retry.

`--dry-run` validates input and shows planned actions without copying anything into the public root or making any Meta write. Add `--check-remote` for read-only duplicate checks. The duplicate scan covers up to 1,000 recent media and fails closed if that pagination bound is exceeded. Pass `--cover-file <approved-cover.png>` to supply the approved cover. The helper converts PNG to JPEG without resizing or redesign, because Meta documents JPEG for `cover_url`; the source cover hash is recorded. JPEG inputs are copied unchanged. It sends `share_to_feed=true`, verifies public video and cover bytes, and removes both temporary assets after publishing or a terminal container error. The caption is read verbatim from its UTF-8 file, including its final newline. Successful publication immediately writes `/srv/safetyradar/social/published/<marker-key>.json` and an ops-journal entry before attempting permalink lookup. Use a stable `--marker-key` such as `reel1_accident`; copy that marker to the box after verification. Never write a published marker before Meta returns a media ID.

## Rebuild the existing ad creatives

The private archive `/srv/safetyradar/social/ads-source` contains the existing `make_ad.py`, `variants.json`, and approved A, B, and C outputs. These were copied unchanged from the working box. No new ad was created.

The generator uses Playwright and ffmpeg. Its default font is DejaVu Sans Bold. It does not create Meta ads. The existing invocation is:

```sh
cd /srv/safetyradar/social/ads-source
/srv/safetyradar/venv-social/bin/python make_ad.py variants.json A B C
```

This command overwrites the archive's `out` files. Copy the generator and variants into a fresh private work directory before producing a new version. The optional `A_voice` variant requires Piper and its German model. That optional voice stack was not installed or migrated.

The ads show the real German website. They hide fatal accident cards, lessons and teasers in listing captures, and the footer. They zoom or scroll through content, then show the newsletter signup page without submitting the form. The final card lasts 5 seconds and says `Safety Radar`, `Gratis Newsletter`, `safetyradar.ch`, and `Wöchentlich das Wichtigste`.

- A, Overview: accidents, rulings, jobs, then signup. On-screen headings are `Arbeitsunfälle`, `Neue Urteile`, `Offene Stellen`, and `Gratis Newsletter abonnieren`. A includes a square output as well as vertical.
- B, Urteile: rulings listing, one safe case, and an outcome highlight, then signup. On-screen text is `Neue Urteile zur Arbeitssicherheit`, `Verständlich zusammengefasst`, and `Gratis Newsletter abonnieren`.
- C, AS/GS-Jobs: job listing, a job card, and a scroll, then signup. On-screen text is `AS/GS-Jobs`, `Arbeitssicherheit & Gesundheitsschutz`, `Alles an einem Ort`, and `Neue Stellen im Newsletter`.

Review every rendered frame sequence against the current site. A changed selector can capture the wrong case. Hide fatal content before capture. Check that no visitor email, personal subscriber information, or unfinished draft appears.

## Keep the existing ads within the approved scope

Verified on 10 November 2026 after the approved landing-only replacement:

- Account: `1873587530725467`. API account path: `act_1873587530725467`.
- Campaign: `52544779549276`, `Safety Radar — DE Newsletter`, objective `OUTCOME_TRAFFIC`.
- Ad set: `52544779664276`, `CH DE Newsletter`.
- Daily ad-set budget: `900` minor units, CHF 9 total across the ads. The owner authorized about USD 10 per day and accepted CHF 9.
- Geography: Switzerland, country code `CH`.
- Language: German, Meta locale `5`.
- Age: 25 through 55.
- Advantage audience automation: `advantage_audience=0`.
- Interests are in one flexible-spec group. They include Suva, risk management, emergency management, construction, building material, construction management, heavy equipment, welding, construction engineering, building, civil engineering, facility management, architecture, architecture and engineering, and construction services and organizations.
- Ads are A `52544780253676`, B `52544780270076`, and C `52544780280676`.
- Current creative IDs are A `2433357704093174`, B `4359070577738674`, and C `1853119972388610`. Previous IDs remain in the operations journal for traceability.
- Video IDs are A `1879778366366579`, B `1867572614399700`, and C `1788007852479791`.
- Page ID: `1338804342660007`. Existing ads use Page-backed Instagram identity `17841429970165089` (`AD_IG_USER_ID`); keep that approved ad identity unchanged. Organic Reels use the real business user `17841441257076577` (`IG_USER_ID`).
- CTA: `SIGN_UP`. Click-through destination: `https://safetyradar.ch/de/`.

The owner rejected Adspirer and paid tools. Do not add a paid orchestration service. Do not create another campaign, widen the audience, activate a new ad, or change a budget without specific owner approval. A paused ad must stay paused until its activation is approved.

The live copy is:

A: `Arbeitsunfälle, neue Urteile und offene Stellen — kompakt und gratis. Safety Radar Newsletter für die Schweiz.` Description: `Wöchentlich das Wichtigste.`

B: `Neue Urteile zur Arbeitssicherheit — verständlich zusammengefasst. Gratis Newsletter von Safety Radar.` Description: `Urteile kompakt erklärt.`

C: `AS/GS-Jobs und das Wichtigste zu Arbeitssicherheit & Gesundheitsschutz. Neue Stellen im gratis Newsletter von Safety Radar.` Description: `AS/GS-Jobs im Newsletter.`

The creative URL tags are exactly:

```text
utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign=de-2026-w46&utm_content=a
```

Use `b` and `c` for the other live variants. `{{site_source_name}}` expands to fb or ig. Put macros in Meta's `url_tags` field, not in a pre-encoded destination URL. Inspect the final delivered destination after any approved change.

## Prepare a paused ad without new spend

No new ad was created during setup. `scripts/ads/ads_create.py` implements this workflow after the owner approves the specific preparation:

1. Validate the local video and thumbnail. Calculate a stable fingerprint of video, copy, destination, UTM tags, and existing ad-set ID.
2. Read the account currency and existing ad-set ID. Require CHF and the approved ad set. Do not create or modify a campaign or ad set.
3. Check a private local journal and existing ads for the fingerprint. Reuse recorded video and creative IDs on a retry.
4. Upload the video with `POST /act_1873587530725467/advideos` using the documented multipart upload. Poll processing status until ready.
5. Upload a reviewed thumbnail through the documented account image endpoint when needed. Reuse the returned image hash or a verified HTTPS thumbnail URL.
6. Create a video creative through `POST /act_1873587530725467/adcreatives`. Supply `object_story_spec` with the existing Page and Instagram IDs, `video_data`, the German message, reviewed thumbnail, and `SIGN_UP` CTA. Supply the controlled `url_tags` separately.
7. Create an ad through `POST /act_1873587530725467/ads` with the existing `adset_id`, the creative ID, and literal `status=PAUSED`.
8. Read the ad back. Confirm the status is PAUSED, the ad set is unchanged, the currency is CHF, and the destination and UTM tags are correct.
9. Save the returned IDs in the journal. Report the paused draft for owner review. Do not activate it.

`--dry-run` must skip video upload, image upload, creative creation, and ad creation. No live write is needed to test payload generation. This implementation has no activation or budget-change capability. Never add or use such a capability without the explicit flag and specific owner approval required for that change. Never treat a flag as approval by itself.

## Read ad results without changing delivery

Read `GET /act_1873587530725467/insights` with `level=ad`, an explicit inclusive `time_range`, and a filter for campaign `52544779549276`. Follow all result pages. Useful fields are `ad_id,ad_name,spend,impressions,reach,actions,inline_link_clicks,cpc,ctr`.

The VPS read-only account test confirmed `currency=CHF` and `timezone_name=Europe/Zurich`. Check `GET /act_1873587530725467?fields=currency,timezone_name` again before interpreting a later report. Label amounts CHF only after the account confirms CHF. Meta insights use the account reporting timezone. Convert user-facing timestamps to Europe/Zurich.

A read-only insights test on cx43 for 9 November 2026 returned all three existing ads. The sanitized snapshot is `/srv/safetyradar/social/read-only-meta-2026-11-09.json`. It contains no token or full API paging URL.

Use `actions` with `action_type=link_click`, or the documented inline link-click field consistently. Link CPC is spend divided by link clicks. Link CTR is link clicks divided by impressions times 100. The API's generic `cpc` and `ctr` can count all clicks, so do not label them link CPC or link CTR without checking their definition. Show a dash when a denominator is zero. Do not sum per-ad reach into a unique campaign reach.

Website pageviews and Meta link clicks are different counters. Never call either one unique visitors. The collector loses blocked, opted-out, and early-exit browser events. The site deliberately has no personal attribution join.

Read `/srv/safetyradar/stats/analytics-latest.txt` for cookieless website cohorts. Newsletter links use `utm_source=newsletter`, `utm_medium=email`, and ISO-week `utm_campaign=2026-w46`. Do not confuse this with the ads' `de-2026-w46` campaign.

The collector stores daily aggregate counters for 56 days. It has no cookies, local storage, fingerprint, reader ID, IP address, email field, Meta Pixel, CAPI, or email-open tracking. It honours GPC and DNT. Submissions, accepted responses, and confirmed responses are separate funnel stages, not additive conversions. Confirmed responses are intentionally not joined to the original ad cohort. Use `sr_test=1` for internal browser tests and `test:true` for test events.

## Handle the Meta token

Read the token only inside the process making the API request. Use an Authorization header. Never put a token in a command argument, URL, crash trace, shell history, Git file, or report. Do not use shell tracing.

On the VPS, the token is `/srv/safetyradar/.secrets/meta_token`, owned by root with mode 600. Its parent is mode 700. It is outside the Git tree. A box copy may exist at `/home/box/.secrets/meta_token`; do not use it. All Meta API reads go through the VPS token and the VPS scripts. The app secret remains in the box environment as `META_APP_SECRET` and must not be printed or copied into chat.

The read-only permissions check succeeded from cx43. Granted scopes were `pages_show_list`, `ads_management`, `ads_read`, `instagram_basic`, `instagram_manage_comments`, `instagram_content_publish`, `instagram_manage_messages`, `pages_read_engagement`, and `public_profile`. `pages_manage_posts` is absent. Do not claim Facebook Page posting works.

The existing token was described as non-expiring in the handover context. A fresh expiry introspection was not performed. A non-expiring token can still be revoked, lose asset access, or fail after account changes. On an authentication error, stop writes, inspect permissions through the official API, and obtain a replacement through the owner's approved Meta app or Business settings flow. Transfer the replacement through a secure file channel. Replace the root-only file atomically, then run read-only checks. Never seek credentials in browser sessions or print app secrets to diagnose access.

Recheck the supported API version before a later migration. Do not silently move from v21.0 or expand scopes.

## Build and send the newsletter

The user gave standing permission for automatic list sends every Monday at 09:00 Europe/Zurich without another approval request. Hold only if the build fails, the issue is empty, or there is a clear factual or broken-link problem. Do not add a new approval gate or stop because of subjective design preferences.

The owner accepted a simple email. Do not redesign it into a branded campaign.

The build timer calls `deploy/newsletter/weekly-issue.mjs`. It creates or updates same-week drafts for DE, FR, IT, and EN. Public lists are DE 3, FR 4, IT 5, and EN 6. The service also sends the configured DE and EN owner previews. Never trigger that preview as an unrequested test during setup.

Use this build-only inspection command when needed:

```sh
cd /srv/safetyradar/app
node deploy/newsletter/weekly-issue.mjs --dry-run --html=/tmp/safetyradar-issue-preview.html
```

The normal external Monday send entry point is:

```sh
/srv/safetyradar/app/deploy/newsletter/send-week.sh 2026-w46
```

Use the current ISO week, not the example forever. Do not run this command as a setup test. Inspect the issue summary under `/srv/safetyradar/newsletter` and its Listmonk status first. Do not resend an already-sent issue. Do not use a force or immediate-send override outside the approved Monday slot without specific approval.

The newsletter includes newly added, recent cases. Accidents use event dates. Rulings use release dates or a separately labelled first-seen fallback, never a false release date copied from the decision date. Preserve the existing recency and de-duplication checks. Keep tracking pixels out of the campaign template. Do not write masked Listmonk passwords back through the settings API.

Keep `safetyradar-newsletter-send.timer` disabled. The external routine owns the send and its sanity checks. A second sender can double-send.

## Sync code without losing VPS data

Keep code changes on the repository's source-control provider. Keep production data changes on cx43. The VPS has read-only HTTPS access to the public repository and must not gain push credentials for this task.

Before a sync, inspect `git status --short`, the current HEAD, and the local-only commits. Preserve commit `653d37a` and any later local data history. Do not push VPS main to GitHub. Do not use a hard reset, force push, or blind data-file checkout.

The existing deployment process rebases local data commits onto new code and validates the result. Its `-X theirs` handling refers to the replayed local commit in a rebase. Do not reinterpret it as a general merge preference. Use the established deploy script rather than inventing a new Git recovery sequence.

For a code-only site deployment, the existing documented route uses `SKIP_STAGE1=1` and `SKIP_REVIEW=1` with the app environment loaded as the systemd service loads it. Confirm the final site build and production data after deployment. A social-only script deployment does not require a newsletter send, Meta write, or budget change.

The tooling change is a code-only commit on GitHub main. No production data is part of that commit. For the initial tooling deployment, merge that code commit into the clean VPS checkout rather than replaying the local data commit. A local merge keeps `653d37a` intact and reachable and keeps all editorial data on the VPS. Verify that its data-file hashes are unchanged. Do not push the resulting VPS merge. Normal future daily deployments retain the established local-data workflow.

## Preserve the owner's editorial and product decisions

- German-speaking ads only, with the existing Switzerland, age, and interest scope.
- CHF 9 per day total for the existing ad set. No other campaign or spend.
- No paid tools or Adspirer.
- Reels are the news feed. The site is the newspaper. The newsletter is the Monday roundup.
- Prefer recent cases, whole paragraphs, readable titles, and correct fine arithmetic.
- Use source-confirmed injuries. Never infer facts or legal outcomes.
- Keep curated lessons tied to an approved corpus and the specific case.
- Use Swiss spelling and AS/GS terminology.
- Prefer pragmatic accuracy over extra machinery.
- Keep measurement cookieless. Do not add an intrusive cookie banner, Meta Pixel, CAPI, or personal tracking.
- Keep the newsletter simple.

## Get approval for external changes

Ask the owner to approve each new Reel and its caption and slot before publishing. The existing Tuesday and Thursday approvals apply only to their existing two Reels. Ask before any new spend, activation, budget change, new campaign, or audience expansion. Ask before any other unapproved external post or send.

The standing Monday 09:00 newsletter permission is the exception. It is not permission for ad activation, Instagram posts, test sends, subscriber exports, or a new send schedule.

Rendering, fact checks, private file preparation, read-only reports, and dry-run payload checks need no new approval. They must not publish a media container, create a creative, activate an ad, or expose a private asset.

## Troubleshoot without increasing risk

If Playwright cannot import, use `/srv/safetyradar/venv-social/bin/python`, not system Python. If Chromium is missing, install it through that environment's Playwright CLI. The browser cache is currently under `/root/.cache/ms-playwright`, so the verified render runs as root. A future unprivileged render service needs its own browser install and appropriate private-output permissions.

If a font is missing, use `--font-dir /srv/safetyradar/fonts`. Do not rely on `/tmp` surviving a reboot. If ffmpeg fails, inspect the actual encoder error, available disk space, and the input frames. Do not publish a partial MP4.

If the container remains in progress, wait with a bounded poll. Check that the temporary HTTPS video is still available. Stop on a terminal error. Do not compensate by posting a second copy.

If Meta returns a permission or token error, stop writes. Verify the token file mode and read-only scope response. Do not grant new scopes, rotate credentials, or broaden access without the approved account flow.

If `/srv/safetyradar/stats/status-latest.txt` starts with `meta_api_health: BLOCKED`, Meta has locked API access on the developer app, usually after "unusual activity". This is not a campaign, budget, or expired-token problem by itself. Ask the owner to confirm the account at developers.facebook.com from his own laptop. Agents must not log in to Facebook or Meta from the box browser, and must not call the Graph API from the box.

On 10 November 2026, Meta flagged the owner's developer account for unusual activity. Every Graph API call returned OAuthException code 200, "API access blocked", until the owner confirmed identity with an email code and a mobile number in the browser at about 20:48 Europe/Zurich. Access then worked again. The likely trigger was browser logins and API calls from changing cloud IPs on the bot box. After this incident, all Meta reads are taken only from cx43's stable address via the token scripts, and the status snapshot records `BLOCKED`, `TOKEN`, or `PERMISSION` with the `fbtrace_id` in the status file and in `/srv/safetyradar/ops/journal.jsonl`.

If a publish result is uncertain, recover from the saved container ID and recent media before retrying. If a temporary file remains, remove only the path recorded for that job after checking that Meta no longer needs it.

If an ad is rejected, read the rejection and review the copy and creative. Do not evade review through a different account or a renamed duplicate. Do not activate a replacement without approval.

If newsletter build or link checks fail, hold the send and report the concrete problem. Keep the issue draft. Leave the send timer disabled.

If a data rebase conflicts, preserve the local data history and stop the sync. Do not push it or discard it to make a code deploy pass.

Read relevant service logs with `journalctl -u <service>`. Never dump environment files, credential files, subscriber records, or full HTTP request headers into logs or chat.
