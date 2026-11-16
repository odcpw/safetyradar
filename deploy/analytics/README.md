# Aggregate measurement

No SaaS, localStorage/sessionStorage, fingerprint, email address, IP address or raw referring URL. No Meta pixel or email-open tracking. The only exception is the server-side Meta Conversions API for visits that arrived from a Meta ad (see below). GPC/DNT honoured. The collector never receives form fields. It stores daily **aggregate counters**, not event logs, for 56 days in `/srv/safetyradar/stats/events`. `.test.json` files are excluded from reports. The service updates `analytics-latest.json` and `analytics-latest.txt` every minute in `/srv/safetyradar/stats`; the existing weekly stats command also refreshes these files. These are private server files, not a new public dashboard.

## Campaign convention

Meta website URL: `https://safetyradar.ch/de/` (or an exact `/de/accidents/ID/` / `/de/rulings/ID/` page).

Meta **URL parameters** field, variant A:

```
utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign=de-2026-w45&utm_content=a
```

Use `b` / `c` for other creatives; update ISO week for a new campaign. Only fb/ig paid_social with `<language>-YYYY-wNN` and variants a/b/c are accepted. Meta officially documents `{{site_source_name}}`; fb and ig distinguish placement platforms. Put macros in URL parameters, not a manually encoded destination URL; verify final delivered link in ad setup. Other platforms are deliberately unattributed. Reference: https://en-gb.facebook.com/business/help/2360940870872492

Newsletter: existing `scripts/lib/utm.mjs` produces `utm_source=newsletter&utm_medium=email&utm_campaign=2026-w45&utm_content=a` (content optional). Language and article come from the actual canonical page, not a freeform parameter.

Only controlled tags propagate through internal links and the Listmonk form action. The latter carries public campaign cohorts and `sr_lang`, **not subscriber attributes**. No email or subscriber ID is attached to website measurement; tags are not copied into the personalized opt-in link.

## What the counters mean

- `pageviews`: observed browser document loads. Caddy HTML requests remain a separate metric, not added to browser views. Neither is a unique-reader/session count, Meta click count or guaranteed-human count. JS blockers, opt-outs and early exits cause losses.
- `engagementSamples`, `activeSeconds`: one sample per document at first hidden/leave. Visible time only, stops after 60 seconds without input/scroll; rounded to 5 seconds, capped at 30 minutes. Later activity in the same restored document is not added. This is a lower-bound attention proxy, not proof of reading. Depth thresholds measure viewport reach, not comprehension.
- `signupSubmissions`: valid browser form submissions observed once per form/document. No email value is read. Failed navigation or an already-subscribed address is still an attempted request.
- `signupAcceptedResponses`: Listmonk success/pending responses only, not fresh subscribers. Repeated accepted requests can occur. Campaign and page-language retained as aggregate cohorts.
- `signupConfirmedResponses`: success template emitted **after** Listmonk's confirmation operation, never its pending/no-subscriptions/error page. Reloading an already-confirmed link does not emit again; prefetch/races/JS loss can still affect observations. Public list UUIDs map only to a language; unknown/multiple languages remain `und`. No subscriber UUID/path is transmitted. Original acquisition campaign cannot safely be recovered here and is intentionally **unattributed**, not guessed/joined to email.
- Never add submissions + accepted + confirmed as conversions. These are independent funnel stages, not linked-person conversion rates. No “regular readers” or cross-device attribution.

By-source/variant, language/category/article and total counters are available in the JSON/text report. Confirmation totals cannot supply ad-specific confirmed-subscription ROI without extra personal linkage, which is deliberately absent.

## Deployment and tests

Install the measurement systemd unit (Node only, no `.env`/API keys), create `/srv/safetyradar/stats/events` owned by safetyradar, then enable it. Run `install-routing.py` as root: validates before changing only the two Safety Radar Caddy blocks. Main-site access logging retains only existing public HTML paths and a bot flag, never raw URI/query/referrer. News access logging stays off (opt-in paths contain subscriber UUIDs). New writer is `safetyradar-pages.log`; run `sanitize-legacy-logs.mjs` once after reload to redact closed old logs, preserving safe counts and controlled legacy newsletter cohorts. Copy the two public Listmonk template overrides and restart Listmonk; do not change settings or send campaigns. The existing weekly stats unit also removes expired closed legacy logs/summaries (56-day age policy, weekly cleanup). Static measurement modules are served from the website release on both hosts.

Use `?sr_test=1` for internal browser tests, or JSON `test:true`. Caddy flags the former as a bot; measurement writes test counters separately. Endpoint tests do not submit an email. Test/error bodies are never logged. Global in-memory request cap and bounded cohorts limit spam; spoofing/bots cannot be completely eliminated without identifying readers.

## Per-visitor journeys (sr_vid cookie)

Owner-approved on 16 November 2026 to see which pages one visitor opens, in what order and for how long (especially Meta ad visitors).

- `public/measurement.js` sets one first-party cookie, `sr_vid` = 32 hex chars from `crypto.getRandomValues` (no personal data), `Max-Age` 90 days, `Path=/; SameSite=Lax; Secure`, never renewed. Each page load also gets a random page-view id `pv`. Both go in the beacon body (`credentials:'omit'` stays). Not set for DNT/GPC. Never added to the Listmonk form or sent to Meta.
- `deploy/analytics/visits.mjs` appends one row per beacon to `/srv/safetyradar/stats/visits/YYYY-MM-DD.jsonl` (`.test.jsonl` for `sr_test=1`): `ts, vid, sid, pv, event, page, lang, category, article, source/medium/campaign/variant, device (mobile/tablet/desktop), activeSeconds/depth (engagement), ft (visitor's first-touch cohort), returning`. No IP, user agent, referrer or query. Sessions are assigned on the server: a new `sid` after 30 min without a beacon; engagement/signup beacons join the session of their page view. State is rebuilt from the retained files on restart. Rows older than 90 days are deleted every minute; 50,000 rows/day cap.
- Report: `node deploy/analytics/report-journeys.mjs [YYYY-MM-DD|today|yesterday] [--paid] [--test] [--json]` (run as safetyradar in `/srv/safetyradar/app`). The service also writes today's report to `/srv/safetyradar/stats/journeys-latest.txt` every minute.
- The existing aggregate counters below are unchanged.

## Server-side Meta Conversions API (ad clicks only)

Owner-approved on 13 November 2026 to let Meta learn from engaged visits and signups instead of clicks. Still no browser pixel, localStorage or sessionStorage; the sr_vid cookie is never sent to Meta.

- `public/measurement.js` reads `fbclid` from the landing URL, keeps it in memory for the page view, and carries it on internal links like the campaign cohort (never into the Listmonk form). It adds `fbc` (`fb.1.<ms>.<fbclid>`) only to the `engagement` and `signup_submission` beacons, and only when `fbclid` is present.
- `deploy/analytics/capi.mjs` sends `EngagedVisit` (custom) when an engagement sample on the homepage or a single accident/ruling page has at least 20 s active or reached d100, and `Lead` on a signup submission. Visits without `fbc` are never sent. `user_data` is `fbc`, `client_ip_address` (Caddy's `X-Forwarded-For`) and `client_user_agent`. No email or hashed email is sent: the privacy policy promises the address is never shared.
- `event_id` is a hash of event name + fbclid, so one ad click yields at most one EngagedVisit and one Lead (in-memory 48 h guard plus Meta's own dedupe).
- Fire-and-forget, 3 s timeout. `fbc`, IP and UA are never written. Counters and sanitised errors (status, code, message without URLs or tokens, `fbtrace_id`) go to `/srv/safetyradar/stats/capi/YYYY-MM-DD.json` (56 days). The root status snapshot mirrors new errors into `/srv/safetyradar/ops/journal.jsonl` as `capi_error`.
- Config: unit `Environment=CAPI_DATASET_ID=1455663602556769` and `LoadCredential=meta_token:/srv/safetyradar/.secrets/meta_token`. Without the credential the collector runs as before with CAPI off.
- Testing: browser `sr_test=1` / `test:true` events are only sent while a temporary drop-in sets `CAPI_TEST_EVENT_CODE`, and then always with `test_event_code`. Production events never carry a test code. Remove the drop-in after a test.
