#!/usr/bin/env node
// Enrich rulings defendants[].charge with Art./art. numbers the judgment actually applies,
// using a Decisions API loop over a fixed provision catalog (same idea as safetysuiteconstruction
// checklist routing). Then Absätze are filled from the source text when present.
//
// Usage: node scripts/enrich-ruling-articles.mjs [--dry-run] [--only=<id-substring>]
// Needs OPENAI_API_KEY. Writes data/rulings.json (lesson stays null).
import fs from 'node:fs';
import { getText } from './lib/fetch-text.mjs';
import { decide, flush, available } from './lib/llm.mjs';
import { CHARGE_CATALOG, ART_RE, CODES } from './lib/fedlex.mjs';

const DRY = process.argv.includes('--dry-run');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
const PATH = new URL('../data/rulings.json', import.meta.url);
const rulings = JSON.parse(fs.readFileSync(PATH, 'utf8'));

if (!available()) { console.error('OPENAI_API_KEY missing'); process.exit(1); }

const choices = [
  { value: 'charge_basis', description: 'This provision is a legal basis of the charge or conviction for a defendant in this workplace case (Schuldspruch, Anklage, Strafbefehl for the safety offence). Include it even if eventualiter was not needed for the final conviction when it was a charged alternative that stayed live — prefer the provision(s) of the actual Schuldspruch when clear.' },
  { value: 'mentioned_only', description: 'Mentioned only in passing: procedure (BGG/BV), definitions (e.g. Art. 12 StGB negligence), citations of other cases, or an eventualiter charge the court did not rely on for the Schuldspruch.' },
  { value: 'absent', description: 'Not present in this decision text for this case.' },
];

function absFromText(text, art, code) {
  // Prefer "Art. 125 Abs. 2 StGB" near Schuldspruch / Anklage wording
  const re = new RegExp(String.raw`Art\.\s*${art}(\s*Abs\.\s*\d+[a-z]?(?:\s*(?:und|,)\s*\d+[a-z]?)*)?\s*${code}`, 'gi');
  const hits = [...text.matchAll(re)].map(m => m[0].replace(/\s+/g, ' ').trim());
  // Prefer hits that include Abs.
  const withAbs = hits.find(h => /Abs\./i.test(h));
  return withAbs || hits[0] || `Art. ${art} ${code}`;
}

function labelForLang(deLabel, lang) {
  // deLabel like "Art. 125 Abs. 2 StGB"
  const m = deLabel.match(/Art\.\s*(\d+[a-z]?)((?:\s*Abs\.\s*\d+[a-z]?(?:\s*(?:und|,)\s*\d+[a-z]?)*)?)?\s*(StGB|UVG|BauAV|VuV|VUV|ArG)/i);
  if (!m) return deLabel;
  const [, art, abs = '', code] = m;
  const c = CODES[code] || CODES.StGB;
  if (lang === 'de') return `Art. ${art}${abs || ''} ${c.de}`.replace(/\s+/g, ' ').trim();
  if (lang === 'fr') {
    const al = (abs || '').replace(/Abs\./g, 'al.');
    return `art. ${art}${al} ${c.fr}`.replace(/\s+/g, ' ').trim();
  }
  if (lang === 'it') {
    const al = (abs || '').replace(/Abs\./g, 'cpv.');
    return `art. ${art}${al} ${c.it}`.replace(/\s+/g, ' ').trim();
  }
  const para = (abs || '').replace(/Abs\./g, 'para.');
  return `Art. ${art}${para} ${c.en}`.replace(/\s+/g, ' ').trim();
}

function withCite(charge, deLabels) {
  if (!charge || !deLabels.length) return charge;
  // Strip any existing Art./art. parentheticals, then append confirmed ones
  const strip = (s) => (s || '').replace(/\s*\((?:[^)]*(?:Art\.|art\.)[^)]*)\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const base = {
    de: strip(charge.de), fr: strip(charge.fr), it: strip(charge.it), en: strip(charge.en),
  };
  if (!base.de) return charge;
  const cite = {
    de: deLabels.map(l => labelForLang(l, 'de')).join('; '),
    fr: deLabels.map(l => labelForLang(l, 'fr')).join('; '),
    it: deLabels.map(l => labelForLang(l, 'it')).join('; '),
    en: deLabels.map(l => labelForLang(l, 'en')).join('; '),
  };
  return {
    de: `${base.de} (${cite.de})`,
    fr: `${base.fr} (${cite.fr})`,
    it: `${base.it} (${cite.it})`,
    en: `${base.en} (${cite.en})`,
  };
}

let updated = 0, skipped = 0, failed = [];
for (const e of rulings) {
  if (ONLY && !e.id.includes(ONLY)) continue;
  e.lesson = null;
  const urls = [e.source?.url, ...(e.extraSources || []).map(s => s.url)].filter(Boolean);
  let text = '';
  for (const u of urls) {
    try {
      const t = await getText(u);
      if (t && t.length > (text?.length || 0)) text = t;
    } catch {}
  }
  if (!text || text.length < 800) {
    failed.push({ id: e.id, reason: 'no-text' });
    skipped++;
    continue;
  }

  // Cheap prefilter: only ask Decisions about catalog entries that appear in the text
  const mentioned = CHARGE_CATALOG.filter(c => new RegExp(String.raw`(?:Art\.|art\.)\s*${c.art}\b`, 'i').test(text));
  if (!mentioned.length) {
    failed.push({ id: e.id, reason: 'no-catalog-hit' });
    skipped++;
    continue;
  }

  const answers = await decide({
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'Swiss criminal / workplace-safety court decision. For each provision, decide whether it is a charge/conviction basis for a defendant in THIS case. Ignore BGG/BV procedure and Art. 12 StGB (negligence definition). Prefer Schuldspruch provisions over unused eventualiter alternatives when the text is clear.' },
      { type: 'input_json', data: { id: e.id, title: e.title?.de || '', text: text.slice(0, 50000) } },
    ] }],
    questions: mentioned.map(c => ({
      type: 'choice',
      name: c.id,
      instructions: `${c.label} (${c.hint}). Is this a charge_basis, mentioned_only, or absent for this decision?`,
      choices,
    })),
  });

  const basis = mentioned.filter(c => answers[c.id]?.choice === 'charge_basis');
  if (!basis.length) {
    failed.push({ id: e.id, reason: 'no-charge-basis', mentioned: mentioned.map(c => c.id) });
    skipped++;
    continue;
  }

  const deLabels = basis.map(c => absFromText(text, c.art, c.code));
  // Apply the same cite set to every defendant that has a non-empty charge
  // (multi-defendant cases with different charges are rare; refine later if needed)
  for (const d of e.defendants || []) {
    if (!d.charge?.de?.trim()) continue;
    d.charge = withCite(d.charge, deLabels);
  }
  updated++;
  console.log(`  ${e.id}: ${deLabels.join('; ')}`);
}

if (!DRY) {
  fs.writeFileSync(PATH, JSON.stringify(rulings, null, 1) + '\n');
}
flush({ script: 'enrich-ruling-articles', dry: DRY, updated, skipped });
console.log(JSON.stringify({ dry: DRY, updated, skipped, failed }, null, 2));
