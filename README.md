# Safety Radar (safetyradar.ch) – v0.2

Static Astro 5 site (Node ≥ 20), four languages: `/de/ /fr/ /it/ /en/` (root `/` redirects by browser language, default DE).
Content lives in `data/*.json` – no CMS, no database. Free hosting later on Cloudflare Pages or GitHub Pages (build `npm run build`, output `dist`).

    npm install
    npm run dev       # http://localhost:4321/de/
    npm run update    # fetch all sources → relevance filter → draft queue → rebuild site
    npm run fetch     # only fetch into data/queue.json
    npm run queue     # summary + data/queue-report.md (checklist for the reviewer)
    node scripts/reclassify.mjs   # re-apply filter rules to the queue without refetching

## Data model
- `data/accidents.json` – per item: `id` (= URL slug), `date` (event), `canton`, `place`, `industry`/`hazard`/`outcome` (keys, translated in `src/i18n/ui.ts`),
  `source {name,url,lang}` (original source language), optional `extraSources`, `title`, `facts {activity, what, equipment, injuries, emergency, investigation}` and `lesson` – each text field as `{de,fr,it,en}`. `null` = rendered as "not reported".
- `data/rulings.json` – same plus `court`, `caseNumber`, `charge`, `verdict`, `sanction`, `final` (true/false/null).
- `data/jobs.json` – link + title/employer/location/date as published; `role` key.
- Seed generators with the reviewed texts: `scripts/seed/accidents.py`, `scripts/seed/rulings.py`.
- Detail pages: `/{lang}/accidents/{id}/`, `/{lang}/rulings/{id}/`.

## Content rules (copyright / privacy)
Facts only, written from scratch in our own words and structure (fact sheet, not a retelling). Never copy or closely paraphrase article wording.
Always link and name the source. No names of victims or private defendants.

## Pipeline – what is automatic vs. reviewed
1. **Automatic** (`npm run update`): fetch DE/FR/IT/EN sources, dedupe by URL (queue + published), robots.txt check,
   relevance filter (`scripts/relevance.mjs`: workplace keywords in 4 languages, road-traffic/leisure exclusions, foreign publisher/place exclusions,
   Swiss canton/publisher signal, criminal-chamber filter for court decisions, "same canton ±2 days" duplicate check),
   draft skeleton in `data/queue.json` (status `draft`, guessed canton/hazard/industry/outcome), report, rebuild.
   Then, if `OPENAI_API_KEY` is set (skipped with a warning otherwise, or if the API fails):
   - `npm run classify` – labels every new `data/queue.json` item once (`item.llm`, cached by URL hash). News titles: OpenAI
     **Decisions API** (`POST /v1/decisions`, `gpt-6-luna`, input-only billing) sorts accident / ruling / other in batches of 20;
     candidates (p ≥ 0.1) then go to the **Responses API** (`gpt-6-luna`, strict JSON schema) for keep, canton, place, date, industry,
     outcome, language, reason and a dedupe hint (`dupOf`: id of a published entry or `queue:<hash>`). Court decisions from
     entscheidsuche.ch are judged from their full text (HTML or PDF via `pdftotext`, cached in `data/cache/text/`); case numbers already in
     `rulings.json` are matched exactly.
   - `npm run classify:jobs` – labels `data/jobs-queue.json` (`job.llm`: keep, role, canton, reason, repost `group`).
   - `npm run draft:rulings` – for new kept rulings, drafts a full `rulings.json`-shaped entry (DE/FR/IT/EN) into
     `data/drafts/rulings/<id>.json` (max 5/run). Never writes `rulings.json`.
   - `data/review.md` (from `queue-report.mjs`) lists only kept items, grouped by event, with dedupe hints, draft paths, unlinked extra
     sources for published entries, and kept jobs grouped by repost.
   Caps per script run (env): `LLM_MAX_CALLS` 300, `LLM_MAX_TOKENS` 1,000,000, `LLM_MAX_USD` 0.50. Every run appends tokens and
   estimated USD/CHF cost to `data/llm-usage.jsonl`. Models: `LLM_MODEL` / `LLM_DRAFT_MODEL` (default `gpt-6-luna`). Reasoning effort per step: `LLM_EFFORT_EXTRACT` (default `low`),
   `LLM_EFFORT_JOBS` (`low`), `LLM_EFFORT_DRAFT` (`medium`). `LLM_FIELDS_VIA=decisions` moves the enumerable fields (keep, type,
   canton, industry, outcome, language, dedupe pick from ≤8 nearby entries + 'none'; jobs: keep, role, canton) to the Decisions API
   and keeps Responses only for free text; default `responses`, because on the 2026-10-27 queue it was less accurate
   (missed 1 of 18 published items, 3 vs 1 reviewer-rejected kept, industry/outcome agreement 62 %/77 %; jobs 17 vs 15 extra keeps, 2 canton errors).
   Comparison runs: `LLM_REDO_STAGE2=1` reuses the cached first sort and redoes field extraction. Prices are in
   `scripts/lib/llm.mjs` (verified 2026-10-27 at developers.openai.com/api/docs/pricing). Typical daily cost: < USD 0.02.
2. **Reviewer step (the assistant, on a daily schedule):** read `data/review.md` (not the whole queue). For each new group open the
   source, verify facts, write/adjust the fact sheet + lesson (for rulings start from the draft JSON: check every fact, remove `_draft`),
   add it to `accidents.json`/`rulings.json`, set queue status `published` or `rejected`, rebuild. LLM labels are hints, not facts.
3. **Owner:** spot-check; fill legal TODOs; later deploy.

## Sources (see `scripts/fetch-sources.mjs`)
DE: polizeinews.ch Arbeitsunfälle RSS, Kapo BE blog RSS, (Kapo TG RSS – robots.txt disallows → skipped)
FR: Police VD RSS, Police GE RSS, Police FR RSS, NE "Sécurité" RSS, Police VS RSS, Police JU press page (HTML)
IT: Polizia TI press page www4.ti.ch (HTML parser; unreachable from the build box – TLS reset)
News: Bing News RSS, 15 queries DE/FR/IT/EN (Google News RSS also listed but skipped: robots.txt disallows /rss)
Case law: entscheidsuche.ch search endpoint, all languages, last 180 days.
Jobs: added manually from public ads (no scraping of LinkedIn / jobs.ch / jobscout24).

## TODO before go-live
Owner details (red TODO markers in imprint/privacy/about/post-a-job, all 4 languages); newsletter provider; legal review of privacy text.

## v3 notes
- Hazard categories are hidden in the UI (cards, filters, detail pages); `hazard` stays in the JSON for later use. Severity (`outcome`), industry and canton remain.
- Rulings: `accidentDate`, `date` (ruling), `final`, `appeal`, `employerRole`, `defendants[]` (role, charge, verdict `convicted|acquitted`, reasoning, `sanction{dailyUnits, dailyAmount, suspended, probationYears, fineCHF, custodial, costs, compensation, bail, other}`). `null` = "not reported".
- Every accident and ruling has a stable `caseId`; rulings have `linkedAccidentId` (id of a published accident when it is the same event; otherwise null). No UI for following cases yet.
- Seeds: `scripts/seed/accidents.py` then `scripts/seed/accidents_v3.py`; `scripts/seed/rulings.py`.

## Preview deployment (GitHub Pages)
Private preview at https://safetyradar.ch (GitHub Pages custom domain, `public/CNAME`; old https://odcpw.github.io/safetyradar/ redirects) – `noindex, nofollow` on every page and a disallow-all robots.txt.
`.github/workflows/pages.yml` builds on push to `main` with `SITE=https://safetyradar.ch BASE=/ NOINDEX=1`;
`scripts/rebase.mjs` writes the disallow-all robots.txt (and would prefix links if a non-root BASE were set). A normal `npm run build` targets safetyradar.ch at `/`.

## v4 (2026-10-26)
- Design C: stats strip, canton tile map, chronological list (date/canton gutter, severity edge, 2-line lesson teaser). No design switcher.
- List items expand in place (`<details>`, works without JS) to a slim view; permalink pages keep the same slim content.
- Accidents: one meta line, 1–2 sentence "what happened", lesson, source. Rulings: what happened / decision / why, one line per person, lesson, source.
- Year + month chips with counts, combinable with the canton map and the selects; state lives in the URL (`?canton=BE&year=2025&month=03`, `&open=<caseId>` expands an item).
- Homepage order: rulings, accidents, jobs.
- Data seeds: `scripts/seed/rulings.py` → `rulings_v4.py` (2023–2026 backfill from entscheidsuche.ch, Téléverbier removed); `accidents.py` → `accidents_v3.py` → `accidents_v4.py` (polizeinews.ch archive back to 2024).
- `scripts/fetch-sources.mjs`: new RSS sources from `docs/source-audit.md` (RSI, laRegione, Tio, Stadt Zürich, Stapo Winterthur, Uri, Tamedia, SRF, RTS, 20 Minuten, Blick, Watson; Atom supported). General-media feeds need an incident word in the title; the same event from several outlets is merged into one candidate (`alsoReportedBy`). `--since=2023-01-01` widens the entscheidsuche window; `--only=id1,id2` runs a subset.
