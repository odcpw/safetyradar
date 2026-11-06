import { getText } from './fetch-text.mjs';

/** Map BGer eurospider / caseNumber → entscheidsuche HTML when possible. */
export function entscheidsucheUrls(entry) {
  const out = [];
  const cn = entry.caseNumber || '';
  // 7B_1323/2024 or 6B_784/2025
  const m = cn.match(/\b([6-8]B)_(\d+)\/(\d{4})\b/i) || (entry.id || '').match(/bger-([6-8]b)-(\d+)-(\d{4})/i);
  if (m) {
    const chamber = m[1].toUpperCase().replace('B', 'B'); // 7B
    const num = m[2], year = m[3];
    // date from entry.date YYYY-MM-DD
    const d = entry.date; // 2026-07-03
    if (d) {
      const chamberPad = `00${chamber.replace('B','')}`.slice(-1) === chamber[0]
        ? `00${['','6','7','8'].indexOf(chamber[0])}` : null;
      // Pattern used on entscheidsuche: CH_BGer_007_7B-1323-2024_2026-07-03.html
      const code = chamber[0]; // 6,7,8
      const pad = `00${code}`;
      out.push(`https://entscheidsuche.ch/docs/CH_BGer/CH_BGer_${pad}_${chamber}-${num}-${year}_${d}.html`);
    }
  }
  // Also try any existing entscheidsuche extra
  for (const s of entry.extraSources || []) if (/entscheidsuche\.ch/.test(s.url)) out.push(s.url);
  if (/entscheidsuche\.ch/.test(entry.source?.url || '')) out.push(entry.source.url);
  return [...new Set(out)];
}

export async function bestText(entry) {
  const urls = [
    ...entscheidsucheUrls(entry),
    entry.source?.url,
    ...(entry.extraSources || []).map(s => s.url),
  ].filter(Boolean);
  let best = '', sourceUrl = null;
  const tried = [];
  for (const u of [...new Set(urls)]) {
    tried.push(u);
    try {
      const t = await getText(u);
      if (t && t.length > best.length) { best = t; sourceUrl = u; }
    } catch {}
  }
  return { text: best, sourceUrl, tried };
}
