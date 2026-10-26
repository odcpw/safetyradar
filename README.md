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
2. **Reviewer step (the assistant, on a daily schedule):** open each draft's source, verify facts, write the fact sheet + lesson in DE/FR/IT/EN,
   add it to `accidents.json`/`rulings.json` via the seed scripts, set queue status `published` or `rejected`, rebuild. Court decisions from
   entscheidsuche.ch are pre-filtered by query only and must be read to confirm they concern a workplace accident.
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
Private preview at https://odcpw.github.io/safetyradar/ – `noindex, nofollow` on every page and a disallow-all robots.txt.
`.github/workflows/pages.yml` builds on push to `main` with `SITE=https://odcpw.github.io BASE=/safetyradar NOINDEX=1`;
`scripts/rebase.mjs` prefixes root-relative links with the base and writes the robots.txt. A normal `npm run build` targets safetyradar.ch at `/`.

## v4 (2026-10-26)
- Design C: stats strip, canton tile map, chronological list (date/canton gutter, severity edge, 2-line lesson teaser). No design switcher.
- List items expand in place (`<details>`, works without JS) to a slim view; permalink pages keep the same slim content.
- Accidents: one meta line, 1–2 sentence "what happened", lesson, source. Rulings: what happened / decision / why, one line per person, lesson, source.
- Year + month chips with counts, combinable with the canton map and the selects; state lives in the URL (`?canton=BE&year=2025&month=03`, `&open=<caseId>` expands an item).
- Homepage order: rulings, accidents, jobs.
- Data seeds: `scripts/seed/rulings.py` → `rulings_v4.py` (2023–2026 backfill from entscheidsuche.ch, Téléverbier removed); `accidents.py` → `accidents_v3.py` → `accidents_v4.py` (polizeinews.ch archive back to 2024).
- `scripts/fetch-sources.mjs`: new RSS sources from `docs/source-audit.md` (RSI, laRegione, Tio, Stadt Zürich, Stapo Winterthur, Uri, Tamedia, SRF, RTS, 20 Minuten, Blick, Watson; Atom supported). General-media feeds need an incident word in the title; the same event from several outlets is merged into one candidate (`alsoReportedBy`). `--since=2023-01-01` widens the entscheidsuche window; `--only=id1,id2` runs a subset.
