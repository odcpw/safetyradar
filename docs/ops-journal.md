# Safety Radar operations journal

Times are Europe/Zurich. Live changes need specific owner approval. This journal records completed operations, not standing permission to repeat them.

## 10 November 2026, change the three ad destinations to the homepage

Owner approval: `t234u`, relayed as `pt234u`. Scope was the click-through destination of the existing A, B, and C ads only. The decision baseline was about 2 seconds active time on the signup page and no observed signups after 36 ad visits. The metrics are aggregate browser observations, not unique visitors or a controlled comparison.

At 06:00, before any Meta writes, the VPS opened all six German homepage test URLs, covering fb and ig with variants a, b, and c. Every URL returned HTTP 200. A real mobile Chromium render showed a visible email signup form and submit button. The form action retained the campaign and `sr_test=1`. Each cohort recorded one pageview in `2026-11-10.test.json`. All emitted measurement events were `test:true`, and the production counter file was unchanged during this test. No email form was submitted.

The change completed at 06:02. The click-through link changed from `https://safetyradar.ch/de/newsletter/` to `https://safetyradar.ch/de/`.

- A, ad `52544780253676`: creative `1133845655692149` became `2433357704093174`.
- B, ad `52544780270076`: creative `1127399856533897` became `4359070577738674`.
- C, ad `52544780280676`: creative `1445132723682582` became `1853119972388610`.

The new creatives preserve the exact video IDs, thumbnail image hashes, copy, title, description, SIGN_UP CTA, Page ID, Instagram identity, and creative enhancement opt-outs. The URL tags are unchanged:

```text
utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign=de-2026-w46&utm_content=a
```

B and C retain `utm_content=b` and `utm_content=c`. Only the creative pointer was written on each existing ad. No new ad, budget, audience, campaign, or status change was submitted. Read-back snapshots confirmed that protected ad-set and campaign fields stayed identical, including the CHF 9 total daily budget.

At 06:03, each ad still had configured `status=ACTIVE` and the homepage link. A and C had `effective_status=PENDING_REVIEW`. B had `effective_status=IN_PROCESS`. All three creative objects had `status=ACTIVE`. No ad-review feedback or issues were returned. These are timestamped review states, not a promise of immediate delivery or permanent approval.

Private VPS evidence is under `/srv/safetyradar/social/retarget-homepage-2026-11-10/`, including `before.json`, `after.json`, `preflight.json`, the mobile screenshot, `operation.json`, `result.json`, and `review-readback.json`. Durable operational events are appended to `/srv/safetyradar/ops/journal.jsonl`. Neither location contains the Meta token. Old creatives were retained.

The PAUSED-only creation helper's default destination was changed to the homepage so a future approved preparation cannot silently restore the old landing page. Its offline behavior test checks the destination. No Reel or newsletter was sent during this operation.
