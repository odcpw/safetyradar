# Instagram Reels (Safety Radar)

Operations and takeover: [VPS handover runbook](RUNBOOK-handover.md). It covers the renderer CLI, safe publisher, ads helpers, and approval boundaries.

IG Reels are the **news feed**; [safetyradar.ch](https://safetyradar.ch) is the **newspaper**; the e-mail newsletter is the **Monday roundup** (see also `deploy/listmonk/docs/NEWSLETTER.md`: drafts at Monday 08:00 Europe/Zurich; send Monday 09:00 via external job (VPS send timer disabled)).

Approved layout: **v4** (2026-11-09). Renderer: `scripts/social/make_reel.py`.

## Purpose and roles

| Channel | Role |
|---|---|
| Instagram Reels | Short factual teaser of one recent Unfall or Urteil |
| safetyradar.ch | Full case page with source link and (for accidents) optional corpus lesson |
| Newsletter | Weekly roundup of Unfälle, Urteile, AS/GS-Jobs |

Do **not** invent injuries, numbers, names, articles, or lessons. AS/GS wording only (never “HSE” in on-screen German copy). Swiss German orthography (`ss`, not `ß`).

## Case selection

1. Pick the **most recent** live case by event date (accidents) or **publication** date (rulings) on `https://safetyradar.ch/de/…`.
2. **Skip fatal** accidents for organic Reels (same rule as ad creatives).
3. Facts only from the case page and its linked source.
4. Accident: short summary + corpus lesson **only if the page shows one** (BauAV / VuV / ArG / UVG / Suva / LWR). No lesson → no rule box.
5. Urteil: short summary + offence as stated; cite StGB/other articles **only if the page lists them**. Sanction with **day-fine totals** like the website:

   `180 Tagessätze à CHF 30 (total CHF 5’400), bedingt`

   Format from `src/lib.ts` `chf()` / sanction helper: Swiss apostrophe thousands separator (`’`), `(total CHF …)`, then `, bedingt` when suspended. Verify `dailyUnits × dailyAmount` before rendering.

## Layout (v4)

- **Canvas:** 9:16, 1080×1920.
- **Pinned header:** yellow `safetyradar.ch` chip + large yellow uppercase type label (`UNFALL` / `URTEIL`).
- **Article column** (accumulates; earlier blocks stay visible):
  1. Sublabel (place · canton / court)
  2. Big headline + yellow rule
  3. Paragraphs, each fading/sliding in as a **whole block** (not line-by-line)
  4. Optional yellow sanction box (Urteil)
- When content reaches the **bottom safe area** (~80% of frame height; keep important text above the bottom ~20%), the column **scrolls up** smoothly (teleprompter). Older text clips under the pinned header with a short top fade.
- **End card:** “Jeden Montag im Newsletter: Unfälle, Urteile, AS/GS-Jobs. Link in Bio.” held ≥ 2.5 s.
- Footer watermark: `Safety Radar · safetyradar.ch` (non-critical; may sit in the lower zone).

### Colors

| Token | Hex |
|---|---|
| Background | `#14202D` |
| Accent / chip / type label / sanction box | `#FFCC00` |
| Body text | `#E8EEF5` / white |
| Sublabel / muted | `#C8D0DA` |
| Footer | `#8A95A3` |

Font: **Inter** (Bold + Regular).

### Font sizes (CSS at 540×960 viewport, deviceScaleFactor 2 → final ≈ ×2)

| Element | CSS px |
|---|---|
| Chip | 16 |
| Type label `UNFALL`/`URTEIL` | 36 |
| Sublabel | 15 |
| Headline | 57 |
| Body paragraph | 24 |
| Sanction box | 22 |
| End CTA | 32 |
| End brand / URL | 22 / 18 |
| Footer | 14 |

### Motion

- Paragraph appear: ~0.45 s fade + slight upward settle (whole block).
- Overflow scroll: **16 CSS px/s = 32 px/s at 1080×1920**, eased; no jumps.
- Header stays pinned; article transforms with `translateY`.

## Timing (reading pace)

- Source: Brysbaert, M. (2019). *How many words do we read per minute? A review and meta-analysis of reading rate.* Journal of Memory and Language, 109, 104047. English silent non-fiction average **238 wpm**.
- Pace used for unsolicited phone video (DE): **190 wpm** → `SEC_PER_WORD = 60/190 ≈ 0.316 s`.
- Per block, after it is **fully visible**:

  ```
  hold = words × (60/190) + 1.0 s reaction + 0.35 s × (digit/CHF/Tagessätze/Art./total tokens)
  hold = max(hold, 1.5 s)
  ```

- Sanction box: same formula **+ 2.0 s** extra for dense numbers.
- CTA: `max(formula, 2.5 s)`.
- Next paragraph starts only after the previous hold finishes.

## Encode (Meta-safe)

- `libx264`, `yuv420p`, **30 fps**, CRF ~18
- Color: `tv` / `bt709` (`-color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709`)
- Audio: silent AAC stereo 48 kHz (`anullsrc`), `-movflags +faststart`
- Cover: 1080×1920 PNG still from a mid-content frame

## Captions

Short factual DE body → blank line →

```
Jeden Montag die wichtigsten Unfälle, Urteile und AS/GS-Jobs im Newsletter. Link in Bio.
```

→ blank line → a few relevant hashtags (e.g. `#Arbeitssicherheit #Suva #SafetyRadar #ASGS` plus case-specific tags). Include fine **totals** in the Urteil caption when shown on screen.

## Files and naming

Working directory example: `/workspace/safetyradar-social/YYYY-MM-DD-reels/`

| File | Role |
|---|---|
| `reel1_accident.mp4` | Unfall Reel |
| `reel1_cover.png` | Cover still |
| `reel1_caption.txt` | Caption |
| `reel2_urteil.mp4` | Urteil Reel |
| `reel2_cover.png` | Cover still |
| `reel2_caption.txt` | Caption |
| `make_reel.py` | Renderer (also in repo: `scripts/social/make_reel.py`) |
| `*_vN.*` | Prior version backups |

## Posting rhythm

- **2 Reels / week**, Europe/Zurich:
  - **Unfall:** Tuesday **07:00**
  - **Urteil:** Thursday **07:00**
- Each post needs **explicit owner approval** of that specific Reel (and order) before publish. Scheduled one-off jobs may run the Graph publish; this doc does not authorize sending.

## Instagram publishing (Graph API)

- API: Meta Graph v21.0 from cx43. Use `scripts/social/publish_reel.py`, not a browser.
- IG user id (Page-backed): `17841429970165089`
- VPS token file (root-only, mode 600): `/srv/safetyradar/.secrets/meta_token`. The box backup remains `/home/box/.secrets/meta_token`
  **Never commit or paste the token.** App must be Live; scopes include `instagram_content_publish` (and related IG scopes as granted).
- Recent-media reads return Meta code 10. Publishing stops by default. The individually approved agent-only exception uses `--allow-marker-guard --approval-ref <specific-approval>` and checks the VPS markers, state journals and ops journal under the publishing lock instead. Other errors never fall back. See the runbook before using this exception.
- After approval: supply the approved `--cover-file`, create the REELS container with `cover_url` and `share_to_feed=true`, poll FINISHED, recheck duplicates, publish once, save the marker, and remove temporary video and cover. The cover must be supplied when creating the container, not after publication.
- FB Page posting may require `pages_manage_posts` (often missing); IG content publish is separate.

## Renderer usage

```bash
# On cx43. Rendering does not publish.
/srv/safetyradar/venv-social/bin/python scripts/social/make_reel.py \
  --example accident --output-dir /srv/safetyradar/social/reviewed-accident

# New source-checked copy without editing Python:
/srv/safetyradar/venv-social/bin/python scripts/social/make_reel.py \
  --case-file /srv/safetyradar/social/case.json --dry-run
```

Outputs go to `--output-dir`, defaulting to `/srv/safetyradar/social/YYYY-MM-DD-reels`. Fonts default to `/srv/safetyradar/fonts`, overridable with `--font-dir`. See the runbook for the JSON schema, dry-run publishing, and crash recovery. ffmpeg strips inherited ICC profiles and sets explicit BT.709 frame and encoder metadata.

## Changelog

| Version | Notes |
|---|---|
| v1 | Static-style scenes, too fast |
| v2 | Reading-paced holds, bigger body type, one scene per line |
| v3 | Whole-paragraph fades; big UNFALL/URTEIL; fine totals |
| v4 | Accumulating article + teleprompter scroll on overflow (approved 2026-11-09) |
