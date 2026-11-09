#!/usr/bin/env python3
"""Safety Radar IG Reels v4: accumulating paragraphs + slow overflow scroll."""
import json, math, re, shutil, subprocess, tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

FPS = 30
CSS_W, CSS_H = 540, 960
FONT_REG = "/tmp/inter-fonts/static/Inter-Regular.ttf"
FONT_BOLD = "/tmp/inter-fonts/static/Inter-Bold.ttf"
OUT = Path(__file__).resolve().parent
META_COLOR = ["-color_range", "tv", "-colorspace", "bt709",
              "-color_primaries", "bt709", "-color_trc", "bt709"]

WPM = 190.0
SEC_PER_WORD = 60.0 / WPM
REACTION_S = 1.0
EXTRA_TOKEN_S = 0.35
CTA_MIN_S = 2.5
MIN_BLOCK_HOLD_S = 1.5
FADE_S = 0.45
SANCTION_EXTRA_S = 2.0

# Safe area: top ~12% for IG chrome handled by pad; bottom 20% kept clear
SAFE_BOTTOM = int(CSS_H * 0.80)   # 768
HEADER_H = 168                     # pinned chip+type zone
CONTENT_TOP = HEADER_H + 8         # article visible below header
# Gentle teleprompter scroll (CSS px/s). Full-res = ×2.
SCROLL_CSS_PX_S = 16.0

HTML = """<!DOCTYPE html>
<html lang="de-CH"><head><meta charset="utf-8">
<style>
@font-face {{ font-family: Inter; src: url('file://{font_reg}'); font-weight: 400; font-style: normal; }}
@font-face {{ font-family: Inter; src: url('file://{font_bold}'); font-weight: 700; font-style: normal; }}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html, body {{ width: {css_w}px; height: {css_h}px; overflow: hidden; background: #14202D; }}
body {{ font-family: Inter, sans-serif; color: #fff; position: relative; }}
#header {{
  position: absolute; left: 0; right: 0; top: 0; z-index: 5;
  padding: 110px 36px 14px; background: #14202D;
}}
.chip {{
  display: inline-block; background: #FFCC00; color: #14202D;
  font-weight: 700; font-size: 16px; letter-spacing: 0.01em;
  padding: 7px 14px; border-radius: 999px; line-height: 1;
}}
.type {{
  display: block; margin-top: 18px;
  font-weight: 700; font-size: 36px; line-height: 1.05;
  letter-spacing: 0.06em; color: #FFCC00; text-transform: uppercase;
}}
#topfade {{
  position: absolute; left: 0; right: 0; top: {header_h}px; height: 36px; z-index: 4;
  background: linear-gradient(180deg, #14202D, rgba(20,32,45,0));
  pointer-events: none;
}}
#clip {{
  position: absolute; left: 0; right: 0; top: {header_h}px; bottom: 0;
  overflow: hidden;
}}
#article {{
  position: absolute; left: 0; right: 0; top: 0;
  padding: 10px 36px 48px;
  will-change: transform;
}}
.sublabel {{
  display: block; margin-top: 0;
  font-weight: 700; font-size: 15px; color: #C8D0DA; letter-spacing: 0.02em;
}}
h1 {{
  margin-top: 14px; font-size: 57px; font-weight: 700; line-height: 1.12;
  letter-spacing: -0.025em; max-width: 468px;
}}
.h-rule {{
  width: 56px; height: 5px; background: #FFCC00; border-radius: 2px; margin: 16px 0 8px;
}}
.para {{
  font-size: 24px; font-weight: 400; line-height: 1.38; color: #E8EEF5;
  max-width: 468px; margin-top: 22px;
}}
.box {{
  margin-top: 24px; background: #FFCC00; color: #14202D;
  font-weight: 700; font-size: 22px; line-height: 1.32;
  padding: 18px 20px; border-radius: 16px; max-width: 468px;
}}
.enter {{ opacity: 0; transform: translateY(14px); }}
#main {{ display: block; }}
#main.hide {{ display: none; }}
.end {{
  position: absolute; inset: 0; display: none; flex-direction: column;
  align-items: center; justify-content: center; text-align: center; padding: 80px 32px;
  background: #14202D; z-index: 10;
}}
.end.on {{ display: flex; }}
.end .brand {{ color: #C8D0DA; font-size: 22px; font-weight: 700; margin-bottom: 28px; }}
.end .cta {{
  background: #FFCC00; color: #14202D; font-weight: 700; font-size: 32px;
  line-height: 1.25; padding: 22px 24px; border-radius: 18px; max-width: 460px;
}}
.end .sub {{ margin-top: 24px; color: #C8D0DA; font-size: 18px; font-weight: 400; }}
.footer {{
  position: absolute; left: 0; right: 0; bottom: 70px; text-align: center; z-index: 6;
  color: #8A95A3; font-size: 14px; font-weight: 400; opacity: 0;
}}
.footer.on {{ opacity: 1; }}
</style></head>
<body>
<div id="main">
  <div id="clip">
    <div id="article">
      <div class="sublabel enter" id="el_sub">{sublabel}</div>
      <h1 class="enter" id="el_headline">{headline}</h1>
      <div class="h-rule enter" id="el_hrule"></div>
      {paras_html}
      {box_html}
    </div>
  </div>
  <div id="header">
    <div class="chip">safetyradar.ch</div>
    <div class="type">{type_label}</div>
  </div>
  <div id="topfade"></div>
  <div class="footer" id="footer">Safety Radar · safetyradar.ch</div>
</div>
<div id="end" class="end">
  <div class="brand">Safety Radar</div>
  <div class="cta">Jeden Montag im Newsletter:<br>Unfälle, Urteile, AS/GS-Jobs.<br>Link in Bio.</div>
  <div class="sub">safetyradar.ch</div>
</div>
</body></html>
"""


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def word_count(text: str) -> int:
    parts = re.split(r"[\s·•–—/|]+", text.strip())
    return len([p for p in parts if p])


def extra_tokens(text: str) -> int:
    return len(re.findall(
        r"\d|CHF|Art\.|Abs\.|Tagessätze|StGB|BauAV|UVG|ArG|VuV|total",
        text, flags=re.I,
    ))


def reading_hold(text: str, *, sanction: bool = False) -> float:
    hold = word_count(text) * SEC_PER_WORD + REACTION_S + EXTRA_TOKEN_S * extra_tokens(text)
    if sanction:
        hold += SANCTION_EXTRA_S
    return max(hold, MIN_BLOCK_HOLD_S)


def ease(t):
    return t * t * (3 - 2 * t)


def render(reel):
    tmp = Path(tempfile.mkdtemp(prefix="reel_"))
    fdir = tmp / "frames"
    fdir.mkdir()

    paras = reel["paragraphs"]
    paras_html = "\n".join(
        f'<p class="para enter" id="el_p{i}">{p}</p>' for i, p in enumerate(paras)
    )
    box = reel.get("box")
    box_html = f'<div class="box enter" id="el_box">{box}</div>' if box else ""
    html = HTML.format(
        font_reg=FONT_REG, font_bold=FONT_BOLD,
        css_w=CSS_W, css_h=CSS_H,
        header_h=HEADER_H, content_top=CONTENT_TOP,
        type_label=reel["type_label"], sublabel=reel["sublabel"],
        headline=reel["headline"],
        paras_html=paras_html, box_html=box_html,
    )
    (tmp / "card.html").write_text(html, encoding="utf-8")

    # Build timeline of content blocks (appear order)
    blocks = [
        {"ids": ["el_sub", "el_headline", "el_hrule"], "text": f"{reel['type_label']} {reel['sublabel']} {reel['headline']}", "sanction": False, "focus": "el_headline"},
    ]
    for i, p in enumerate(paras):
        blocks.append({"ids": [f"el_p{i}"], "text": p, "sanction": False, "focus": f"el_p{i}"})
    if box:
        blocks.append({"ids": ["el_box"], "text": box, "sanction": True, "focus": "el_box"})

    # Precompute holds
    for b in blocks:
        b["hold"] = reading_hold(b["text"], sanction=b["sanction"])

    report = []
    scroll_segments = []  # for reporting avg speed
    total_scroll_css = 0.0

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": CSS_W, "height": CSS_H}, device_scale_factor=2)
        page.goto((tmp / "card.html").as_uri(), wait_until="networkidle")
        page.wait_for_timeout(120)

        scroll = 0.0
        frames = []  # list of callables? we'll write frames incrementally
        frame_i = 0

        def set_scroll(y):
            nonlocal scroll
            scroll = max(0.0, y)
            page.evaluate(
                """(y) => { document.getElementById('article').style.transform = 'translateY(' + (-y) + 'px)'; }""",
                scroll,
            )

        def snap():
            nonlocal frame_i
            page.screenshot(path=str(fdir / f"f{frame_i:05d}.jpg"), type="jpeg", quality=92)
            frame_i += 1

        def hold_seconds(sec):
            n = max(1, int(round(sec * FPS)))
            for _ in range(n):
                snap()

        def fade_in(ids, duration=FADE_S):
            n = max(1, int(round(duration * FPS)))
            for i in range(n):
                t = ease((i + 1) / n)
                for eid in ids:
                    page.evaluate(
                        """([id, o, y]) => { const el=document.getElementById(id);
                           if(el){ el.style.opacity=String(o); el.style.transform='translateY('+y+'px)'; }}""",
                        [eid, t, 14 * (1 - t)],
                    )
                snap()
            for eid in ids:
                page.evaluate(
                    """(id) => { const el=document.getElementById(id);
                       if(el){ el.style.opacity='1'; el.style.transform='translateY(0)'; }}""",
                    eid,
                )

        def measure_focus_bottom(focus_id):
            return page.evaluate(
                """(id) => {
                  const el = document.getElementById(id);
                  if (!el) return 0;
                  const r = el.getBoundingClientRect();
                  return r.bottom;
                }""",
                focus_id,
            )

        def measure_focus_top(focus_id):
            return page.evaluate(
                """(id) => {
                  const el = document.getElementById(id);
                  if (!el) return 0;
                  return el.getBoundingClientRect().top;
                }""",
                focus_id,
            )

        def needed_scroll_delta(focus_id):
            """How much more CSS scroll so focus fits in [CONTENT_TOP, SAFE_BOTTOM]."""
            bottom = measure_focus_bottom(focus_id)
            top = measure_focus_top(focus_id)
            delta = 0.0
            # If bottom below safe area, scroll up (increase scroll)
            if bottom > SAFE_BOTTOM - 8:
                delta = max(delta, bottom - (SAFE_BOTTOM - 8))
            # If top under header after that, scroll a bit more so top clears header
            # (apply delta conceptually)
            top_after = top - delta
            if top_after < CONTENT_TOP + 4 and (bottom - delta) > CONTENT_TOP + 40:
                # prefer keeping bottom in view; if para taller than viewport, pin top under header
                overflow_top = (CONTENT_TOP + 4) - top_after
                # only if we aren't already scrolling past
                pass
            return delta

        def scroll_during_hold(focus_id, hold_s, label):
            """After fade, hold for reading; if overflow, scroll smoothly during the hold."""
            nonlocal total_scroll_css
            delta = needed_scroll_delta(focus_id)
            n = max(1, int(round(hold_s * FPS)))
            if delta <= 1.0:
                for _ in range(n):
                    snap()
                report.append({
                    "block": label, "hold_s": round(hold_s, 2),
                    "scroll_delta_css": 0, "scroll_px_s_css": 0,
                })
                return

            # Scroll at SCROLL_CSS_PX_S, but stretch to use up to hold time (never faster than ~1.6x base)
            min_scroll_t = delta / (SCROLL_CSS_PX_S * 1.6)
            scroll_t = min(hold_s * 0.9, max(delta / SCROLL_CSS_PX_S, min_scroll_t))
            scroll_t = max(scroll_t, delta / (SCROLL_CSS_PX_S * 1.6))
            scroll_frames = max(1, int(round(scroll_t * FPS)))
            scroll_frames = min(scroll_frames, n)
            rest = n - scroll_frames
            start = scroll
            target = scroll + delta
            speed = delta / (scroll_frames / FPS) if scroll_frames else 0
            for i in range(scroll_frames):
                t = ease((i + 1) / scroll_frames)
                set_scroll(start + delta * t)
                snap()
            set_scroll(target)
            total_scroll_css += delta
            scroll_segments.append(speed)
            for _ in range(rest):
                snap()
            report.append({
                "block": label, "hold_s": round(hold_s, 2),
                "scroll_delta_css": round(delta, 1),
                "scroll_px_s_css": round(speed, 1),
                "scroll_px_s_full": round(speed * 2, 1),
            })

        # --- Intro: empty beat with chip/type only ---
        hold_seconds(0.35)
        page.evaluate("document.getElementById('footer').classList.add('on')")

        # --- Each block: fade in whole, then reading hold (+ scroll if needed) ---
        t_cursor = 0.35
        for bi, b in enumerate(blocks):
            fade_in(b["ids"], FADE_S)
            t_cursor += FADE_S
            scroll_during_hold(b["focus"], b["hold"], f"b{bi}")
            t_cursor += b["hold"]

        # Brief beat before CTA
        hold_seconds(0.25)

        # CTA
        page.evaluate("""() => {
          document.getElementById('main').classList.add('hide');
          document.getElementById('end').classList.add('on');
        }""")
        cta_text = "Jeden Montag im Newsletter: Unfälle, Urteile, AS/GS-Jobs. Link in Bio."
        cta_hold = max(reading_hold(cta_text), CTA_MIN_S)
        hold_seconds(cta_hold)

        browser.close()
        total = frame_i / FPS

    mp4 = OUT / reel["outfile"]
    run([
        "ffmpeg", "-y", "-framerate", str(FPS), "-i", str(fdir / "f%05d.jpg"),
        "-f", "lavfi", "-t", f"{total:.2f}", "-i", "anullsrc=r=48000:cl=stereo",
        "-vf", "scale=1080:1920,format=yuv420p",
        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS),
        *META_COLOR,
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", "-shortest",
        str(mp4),
    ])

    # Cover: mid content (after a few paragraphs visible)
    cover_t = min(total * 0.45, max(total - cta_hold - 1.0, 3.0))
    cover = OUT / reel["cover"]
    run([
        "ffmpeg", "-y", "-ss", f"{cover_t:.2f}", "-i", str(mp4),
        "-frames:v", "1", "-vf", "scale=1080:1920", str(cover),
    ])

    (OUT / reel["caption_file"]).write_text(reel["caption"].rstrip() + "\n", encoding="utf-8")
    shutil.rmtree(tmp)

    avg_speed = (sum(scroll_segments) / len(scroll_segments)) if scroll_segments else 0.0
    return {
        "mp4": str(mp4), "cover": str(cover),
        "duration": round(total, 2),
        "cover_t": round(cover_t, 2),
        "cta_hold": round(cta_hold, 2),
        "total_scroll_css_px": round(total_scroll_css, 1),
        "total_scroll_full_px": round(total_scroll_css * 2, 1),
        "avg_scroll_css_px_s": round(avg_speed, 1),
        "avg_scroll_full_px_s": round(avg_speed * 2, 1),
        "target_scroll_css_px_s": SCROLL_CSS_PX_S,
        "target_scroll_full_px_s": SCROLL_CSS_PX_S * 2,
        "blocks": report,
        "wpm": WPM,
    }


SANCTION = "Fahrlässige schwere Körperverletzung · 180 Tagessätze à CHF 30 (total CHF 5’400), bedingt"

REELS = [
    {
        "outfile": "reel1_accident.mp4",
        "cover": "reel1_cover.png",
        "caption_file": "reel1_caption.txt",
        "type_label": "Unfall",
        "sublabel": "Oberstammheim · ZH",
        "headline": "Arbeiter stürzt beim Gerüstabbau",
        "paragraphs": [
            "Oberstammheim, 03.11.2026 · Abbau eines Gerüsts.",
            "Ein 37-Jähriger stürzt zu Boden. Ein Metallgegenstand dringt in seinen Oberkörper ein – schwer verletzt.",
            "Polizei und Staatsanwaltschaft untersuchen den Unfall.",
        ],
        "box": None,
        "caption": (
            "In Oberstammheim (ZH) stürzte am 03.11.2026 ein 37-Jähriger beim Abbau eines Gerüsts zu Boden. "
            "Ein Metallgegenstand drang in seinen Oberkörper ein; er wurde schwer verletzt ins Spital gebracht.\n\n"
            "Jeden Montag die wichtigsten Unfälle, Urteile und AS/GS-Jobs im Newsletter. Link in Bio.\n\n"
            "#Arbeitssicherheit #Baustelle #Gerüst #Suva #SafetyRadar #ASGS"
        ),
    },
    {
        "outfile": "reel2_urteil.mp4",
        "cover": "reel2_cover.png",
        "caption_file": "reel2_caption.txt",
        "type_label": "Urteil",
        "sublabel": "Bundesgericht",
        "headline": "Kranlast stösst Zimmermann vom Lastwagen",
        "paragraphs": [
            "Beim Abladen hob der Fahrer eine Palette an, während ein Zimmermann noch auf der Ladefläche stand.",
            "Die Last stiess ihn zu Boden – schwere Verletzungen.",
            "Bundesgericht bestätigt den Schuldspruch des Kranführers.",
        ],
        "box": SANCTION,
        "caption": (
            "Beim Abladen von Isolationspaletten hob der Fahrer eine Palette an, während ein Zimmermann noch auf der Ladefläche stand. "
            "Die Last stiess ihn zu Boden. Das Bundesgericht bestätigte den Schuldspruch des Kranführers wegen fahrlässiger schwerer Körperverletzung: "
            "180 Tagessätze à CHF 30 (total CHF 5’400), bedingt.\n\n"
            "Jeden Montag die wichtigsten Unfälle, Urteile und AS/GS-Jobs im Newsletter. Link in Bio.\n\n"
            "#Arbeitssicherheit #Urteil #Bundesgericht #Kran #Suva #ASGS #SafetyRadar"
        ),
    },
]


if __name__ == "__main__":
    assert 180 * 30 == 5400
    all_info = []
    for r in REELS:
        print("rendering", r["outfile"], "...", flush=True)
        info = render(r)
        all_info.append(info)
        print(json.dumps(info, ensure_ascii=False, indent=2), flush=True)
    (OUT / "timing_report.json").write_text(
        json.dumps({"version": 4, "sanction_text": SANCTION, "reels": all_info},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
