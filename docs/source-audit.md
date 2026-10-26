# Safety Radar – additional source audit (2026-10-26)

Method: fetched each URL with `SafetyRadarBot/0.2` UA via curl; robots.txt parsed with Python `urllib.robotparser` for that UA. "Items/month" = **estimate** from items in the current feed window × keyword hits (Arbeitsunfall/Baustelle/chantier/cantiere/lavoro/Traktor …) on titles; feeds only expose a recent window, so "archive" = oldest item in the feed, not the site archive. Anything not fetched OK is marked **not verified**. Nothing subscribed, no sign-ups.

## Top 10 additions (ranked by expected value)

| # | Source | URL | Why |
|---|---|---|---|
| 1 | RSI Ticino-Grigioni RSS | https://www.rsi.ch/info/ticino-grigioni-e-insubria/?f=rss | Fixes TI gap (ti.ch unreachable). 100 items / 12 days, 3 work-accident titles → est. 5–10 relevant/mo |
| 2 | laRegione Ticino RSS | https://media.laregione.ch/files/domains/laregione.ch/rss/rss_ticino.xml | 50 items / 5 days, often reprints polizia cantonale releases. est. 3–8/mo |
| 3 | Tio.ch Ticino RSS | https://media.tio.ch/files/domains/tio.ch/rss/rss_ticino.xml | 20 items / ~1 day, fast cronaca. est. 3–8/mo (overlaps #2) |
| 4 | Stadt Zürich Medienmitteilungen RSS (incl. Stadtpolizei) | https://www.stadt-zuerich.ch/content/web/de/aktuell/medienmitteilungen/jcr:content/mainparsys/teaser.rss | Official, city of ZH; 10 items/~6 days, all depts → filter. est. 1–3/mo |
| 5 | Tamedia regional RSS (24heures, TdG, Tages-Anzeiger, BZ, BaZ) | https://www.24heures.ch/rss.html, https://www.tdg.ch/rss.html, https://www.tagesanzeiger.ch/rss.html, https://www.bernerzeitung.ch/rss.html, https://www.bazonline.ch/rss.html | ~55–58 items each covering ~1–2 days. est. 2–5/mo each, lots of overlap with police |
| 6 | SRF News RSS (Schweiz / regional) | https://www.srf.ch/news/bnf/rss/1890 (and 1646) | 60 items/3 days; regional journal picks up fatal work accidents. est. 2–4/mo |
| 7 | RTS Régions RSS | https://www.rts.ch/info/regions/?format=rss/news | 25 items/4 days; Romandie. est. 1–3/mo |
| 8 | Google Alerts – **email** delivery | https://www.google.com/alerts (needs a Google account) | Best long-tail recall in DE/FR/IT; email parse into pipeline. est. 10–30 hits/mo (noisy). RSS delivery exists but feed path is robots-disallowed (see §2) |
| 9 | Kanton Uri news RSS (incl. Kapo UR) | https://www.ur.ch/news-ur.rss | 10 items/10 days, all depts. est. 0–1/mo, but only machine-readable source for UR |
| 10 | 20 Minuten partner feed / Blick / Watson | https://partner-feeds.20min.ch/rss/20minuten, https://www.blick.ch/news/rss.xml, https://www.watson.ch/api/1.0/rss/index.xml | National, high volume, low precision. est. 1–3/mo each, mostly duplicates |

Also worth wiring as email (no RSS found): Kapo ZH, AG, SO, SZ, ZG, NW, GL newsletters (§1).

## 1. Police media pages

| Canton/City | Page / feed | Type | Lang | robots | Notes |
|---|---|---|---|---|---|
| FR, VD, GE, NE, VS, BE(blog), JU | (already used) | RSS/HTML | fr/de | allow | fr.ch feed: 50 items back to 2026-07-16 |
| ZH Kapo | https://www.zh.ch/de/sicherheitsdirektion/kantonspolizei-zuerich/medienmitteilungen.html ; abo: https://www.zh.ch/de/newsabo.html | HTML + email | de | allow | No RSS link found; kapo.zh.ch did not respond |
| Stadtpolizei Zürich | via Stadt ZH teaser.rss (above) | RSS | de | allow | verified 200, 10 items |
| Stadtpolizei Winterthur | https://www.stadtpolizei.ch/content/web/de/politik-und-verwaltung/stadtverwaltung/sid/stapo/jcr:content/mainparsys/teaser_copy.rss | RSS | de | allow | verified, only 3 items (teaser, small) |
| SG Kapo | https://www.kapo.sg.ch — page advertises `.../_jcr_content/NewsPar.AtomFeed.qualident__item0.xml` | Atom (advertised) | de | allow | Feed URL returned HTML, **not verified working** |
| Stadtpolizei St. Gallen | not verified | | | | |
| LU Luzerner Polizei | https://polizei.lu.ch | HTML | de | ? | luzernerpolizei.ch timed out; no RSS found. **not verified** |
| AG Kapo | https://www.ag.ch/de/verwaltung/dvi/kantonspolizei/medienmitteilungen ; abo https://www.ag.ch/de/newsletter | HTML + email | de | allow | no RSS |
| SO | https://so.ch/verwaltung/departement-des-innern/polizei-kanton-solothurn/medienmitteilungen/ ; abo https://so.ch/newsletter-1/ | HTML + email | de | allow | |
| SZ | https://www.sz.ch/kantonspolizei ; abo https://www.sz.ch/services/newsletter/abonnements.html/8756-8761-12315-11845 | HTML + email | de | allow | |
| ZG Zuger Polizei | https://www.zg.ch/de/sicherheit/polizei ; abo https://www.zg.ch/de/unsere-newsletter | HTML + email | de | allow | |
| UR | https://www.ur.ch/news-ur.rss | RSS | de | allow | verified |
| NW | abo https://www.nw.ch/newsabo | email | de | allow | |
| GL | abo https://www.gl.ch/public-newsroom/newsletter-abonnieren.html/4527 | email | de | allow | |
| TG | RSS exists but robots-disallowed (known) | | | | |
| BS, BL, SH, AR, AI, OW, GR | pages fetched/attempted, **no RSS found / not verified** | | | | polizeinews.ch already aggregates most DE cantons |
| TI | ti.ch unreachable from our host (confirmed again) | | it | | use RSI/laRegione/Tio |
| Lausanne, Genève city police | **not verified** (policelausanne.ch no response) | | fr | | |
| polizeinews.ch main feed | https://www.polizeinews.ch/feed/ | RSS | de | allow | 48 items/2 days (~700/mo); Arbeitsunfälle category already used, main feed adds little |

## 2. Google Alerts
- Email delivery: allowed, official (support.google.com/websearch/answer/4815696). Parse emails into the pipeline.
- RSS delivery: still offered as of Oct 2026 (third-party guides tested 2026-10-08; undocumented by Google). **But google.com/robots.txt has `Disallow: /alerts/`** (only /alerts/$, /manage, /remove allowed) → feed URLs `/alerts/feeds/...` are disallowed for our fetcher. Use email.

## 3. Newspapers

| Source | Feed | Lang | robots | Window in feed | Est. relevant/mo |
|---|---|---|---|---|---|
| 20 Minuten | https://partner-feeds.20min.ch/rss/20minuten | de | allow | 112 items (some old, to 2024) | 1–3 |
| Blick | https://www.blick.ch/news/rss.xml | de | allow | 33 items/2 days | 1–3 |
| Watson | https://www.watson.ch/api/1.0/rss/index.xml | de | allow | 76 items | 0–2 |
| SRF | https://www.srf.ch/news/bnf/rss/1890 , /1646 | de | allow | 60–75 items | 2–4 |
| RTS | https://www.rts.ch/info/regions/?format=rss/news , /info/suisse/?format=rss/news | fr | allow | 25 items/4 days | 1–3 |
| RSI | ticino-grigioni-e-insubria/?f=rss , svizzera/?f=rss | it | allow | 100 items/12–14 days | 5–10 |
| Le Temps | https://www.letemps.ch/articles.rss | fr | allow | 21 items/1 day | <1 |
| 24heures / TdG | /rss.html | fr | allow | 58 items/2 days | 2–5 |
| Tages-Anzeiger, BZ, BaZ | /rss.html | de | allow | ~55 items/<1 day | 1–3 each |
| ZSZ, Landbote | /rss.html → 302 | de | — | not verified |
| laRegione | media.laregione.ch/.../rss_ticino.xml (+svizzera etc., list at /rss) | it | allow | 50 items/5 days | 3–8 |
| Tio | media.tio.ch/.../rss_ticino.xml (list at /rss) | it | allow | 20 items/1 day | 3–8 |
| Südostschweiz | beta.suedostschweiz.ch/feed/{graubuenden,glarus,linth} | de | **DISALLOW** (`Disallow: /` on beta host) | 50 items | do not use |
| CH Media (Aargauer Z., Luzerner Z., Tagblatt) | /*.rss → 403 Cloudflare challenge, robots.txt itself behind challenge | de | unreadable | — | not usable |
| Le Nouvelliste, Arcinfo (ESH) | /rss 404; robots allow * (blocks AI bots); newsletters /pages/inscription-aux-newsletters/ | fr | allow | no feed found | email only |
| La Liberté | /rss 403 | fr | — | not verified |
| Corriere del Ticino | /rss 404 | it | allow | not verified |
| Le Quotidien Jurassien, Walliser Bote (pomona.ch), Bote der Urschweiz | no feed found (bote.ch: newsletter only) | | | not verified |
| Keystone-SDA | paid agency service; no public feed | | | not checked further |

## 4. Rulings
- entscheidsuche.ch: robots `Disallow: /api/*` only; our `/_search.php` path allowed. Docs at https://entscheidsuche.ch/docs/ (200). Covers federal + all cantonal court publications it scrapes; no RSS found.
- Obergericht ZH: https://www.gerichte-zh.ch/medien.html (200, HTML, no RSS found).
- Basel-Stadt: https://www.bs.ch/medienmitteilungen (200, HTML, no RSS found; covers Strafgericht/StA releases).
- Ministère public GE/VD, Ministero pubblico TI, bger.ch: **not verified** (404 / no response from our host this run).
- Strafbefehle: not published online. Per BGE 124 IV 234 / BGE 147 I 463 they must be available for inspection (Einsichtnahme) at the issuing Staatsanwaltschaft, typically on written request, sometimes for a limited period (e.g. 30 days ZH practice). Not feed-able; request-based only. (From legal knowledge, not fetched today.)

## 5. Trade / official
| Source | Result |
|---|---|
| Suva | media page path 404; newsletter https://www.suva.ch/de-ch/ueber-uns/magazin-und-medien/newsletter (link found). No RSS verified |
| SECO news | https://www.seco.admin.ch/seco/de/home/seco/nsb-news.html (200, HTML); admin.ch NSB has RSS but URL not verified |
| BFU | /de/rss 404; newsletter /de/services/newsletter |
| Baublatt | no RSS; newsletter https://www.baublatt.ch/newsletter-anmeldung |
| espazium (SBZ/TEC21) | no RSS; newsletter https://www.espazium.ch/de/newsletter |
| BUL (farm safety) | newsletter https://www.bul.ch/kontakt/newsletter |
| EKAS | homepage 200, no feed found |
| Cantonal Arbeitsinspektorate, Arbeitssicherheit Schweiz | not verified |
These publish few incident-level items (statistics/campaigns); low value for the incident feed, medium for context.

## Jobs crawler (`npm run fetch:jobs`, audited 2026-10-26)

`scripts/fetch-jobs.mjs` runs daily inside `npm run update`. It checks robots.txt before every request, sends ~1 request/second
as `SafetyRadarBot`, keeps only title, employer, place/canton, language, posting date, URL and source (no ad text), filters titles to
safety roles (DE/FR/IT/EN regex; drops IT/cyber, food, patient, drug safety and apprenticeships), dedupes against `data/jobs.json`
and itself (URL + normalized title/employer), drops inactive postings and anything older than 60 days, and writes
`data/jobs-queue.json` + `data/jobs-queue-summary.md` (both gitignored). Nothing is published automatically.

### Used
| Source | Endpoint type | robots.txt | Notes |
|---|---|---|---|
| jobs.ch | public search page `/de/stellenangebote/?term=…` (also `/fr/offres-emplois/`, `/en/vacancies/`); result JSON embedded in `window.__INIT__` | search pages allowed; `/api/`, `/api_proxy/`, `/*?*feat=`, `/detail/*/*/*` disallowed (not used) | 14 terms × 1 page (20 hits). Search is semantic, so most hits are noise and get filtered out. |
| jobup.ch | same JobCloud platform, `/fr/emplois/?term=…` | same as jobs.ch | 5 FR terms. |
| jobscout24.ch | public HTML category pages `/de/jobs/<keyword>/` | allowed (`/careers/`, `/companies/`, `/de/apply/` etc. disallowed) | stellen.ch redirects here. Only relative dates (“2 W”), so dates are approximate or missing. |
| Novartis | Workday CXS JSON `POST /wday/cxs/novartis/Novartis_Careers/jobs` | allowed (only `/refreshFacet/` disallowed) | No safety hits on first run. |
| Alcon | Workday CXS JSON `careers_alcon` | allowed | No safety hits on first run. |

### Excluded
| Source | Reason |
|---|---|
| Indeed (ch.indeed.com) | HTTP 403 + captcha for our bot; `/*?rss` disallowed; ToS forbid automated access. |
| LinkedIn | robots.txt says crawling needs permission; `/jobs-guest/` and `/jobs?runSearch` disallowed. |
| job-room.ch / arbeit.swiss (SECO) | robots.txt: “Do not crawl Job Adverts”, `Disallow: /job-search/`. The job-room API needs an API agreement with SECO. |
| SmartRecruiters API (api.smartrecruiters.com) | robots.txt allows only LinkedInBot; `User-agent: * Disallow: /`. |
| ABB (Workday) | robots.txt disallows `/External_Career_Page/` (the career site we would query). |
| ostjob.ch / westjob.ch | ostjob blocks many job bots, disallows `/api` and `/export`; the search is a JS app with no stable public URL. westjob.ch did not respond. |
| profession.ch | did not respond (connection failed). |
| Roche (Phenom careers.roche.com) | search is rendered client-side via a Phenom API; not added (could be added later if a public feed turns up). |
| Greenhouse/Lever | boards probed for Sika, Holcim, Implenia, Lonza, Stadler, Axpo: none exist (404). |
| Holcim, Sandoz, Givaudan, Nestlé, Zurich, Swiss Re, Syngenta, Lonza (Workday guesses) | tenant/site name unknown (HTTP 4xx); not added. |
| suissepro.org, SGAS | no machine-readable job board; check by hand. |
