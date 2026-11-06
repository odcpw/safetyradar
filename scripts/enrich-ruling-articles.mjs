#!/usr/bin/env node
// Enrich rulings defendants[].charge with Art./art. numbers from Anklage + Schuldspruch,
// using Decisions over a fixed provision catalog (safetysuiteconstruction-style loop).
// BGer pages often fail TLS here → fall back to entscheidsuche when caseNumber looks like 6B_…/7B_….
//
// Usage: node scripts/enrich-ruling-articles.mjs [--dry-run] [--only=<id-substring>]
import fs from 'node:fs';
import { bestText, entscheidsucheUrls } from './lib/ruling-text.mjs';
import { decide, flush, available } from './lib/llm.mjs';
import { CHARGE_CATALOG, CODES } from './lib/fedlex.mjs';

const DRY = process.argv.includes('--dry-run');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
const PATH = new URL('../data/rulings.json', import.meta.url);
const rulings = JSON.parse(fs.readFileSync(PATH, 'utf8'));

if (!available()) { console.error('OPENAI_API_KEY missing'); process.exit(1); }

const choices = [
  { value: 'charge_basis', description: 'Named in the Anklage / Strafbefehl / Schuldspruch as an offence the defendant was charged with or convicted of (including eventualiter / hilfsweise alternatives that were actually charged). Show these on the site.' },
  { value: 'mentioned_only', description: 'Only procedural (BGG/BV), a definition (e.g. Art. 12 StGB), a cite of another case, or background — not a charge or conviction for a defendant in THIS case.' },
  { value: 'absent', description: 'Not present in this decision text for this case.' },
];

function absFromText(text, art, code) {
  // Capture Abs. / lit. before the code: Art. 112 Abs. 1 lit. d UVG
  const re = new RegExp(String.raw`Art\.\s*${art}((?:\s*Abs\.\s*\d+[a-z]?(?:\s*(?:und|,)\s*\d+[a-z]?)*)?(?:\s*lit\.\s*[a-z])?)\s*${code}`, 'gi');
  const hits = [...text.matchAll(re)].map(m => (`Art. ${art}${m[1] || ''} ${code}`).replace(/\s+/g, ' ').trim());
  const withAbs = hits.find(h => /Abs\.|lit\./i.test(h));
  return withAbs || hits[0] || `Art. ${art} ${code}`;
}

function labelForLang(deLabel, lang) {
  const m = deLabel.match(/Art\.\s*(\d+[a-z]?)((?:\s*Abs\.\s*\d+[a-z]?(?:\s*(?:und|,)\s*\d+[a-z]?)*)?(?:\s*lit\.\s*[a-z])?)?\s*(StGB|UVG|BauAV|VuV|VUV|ArG)/i);
  if (!m) return deLabel;
  const [, art, abs = '', code] = m;
  const c = CODES[code] || CODES.StGB;
  if (lang === 'de') return `Art. ${art}${abs || ''} ${c.de}`.replace(/\s+/g, ' ').trim();
  if (lang === 'fr') {
    let al = (abs || '').replace(/Abs\./g, 'al.').replace(/lit\./g, 'let.');
    return `art. ${art}${al} ${c.fr}`.replace(/\s+/g, ' ').trim();
  }
  if (lang === 'it') {
    let al = (abs || '').replace(/Abs\./g, 'cpv.').replace(/lit\./g, 'lett.');
    return `art. ${art}${al} ${c.it}`.replace(/\s+/g, ' ').trim();
  }
  let para = (abs || '').replace(/Abs\./g, 'para.').replace(/lit\./g, 'lit.');
  return `Art. ${art}${para} ${c.en}`.replace(/\s+/g, ' ').trim();
}

function withCite(charge, deLabels) {
  if (!charge || !deLabels.length) return charge;
  const strip = (s) => (s || '').replace(/\s*\((?:[^)]*(?:Art\.|art\.)[^)]*)\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const base = { de: strip(charge.de), fr: strip(charge.fr), it: strip(charge.it), en: strip(charge.en) };
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
  const { text, tried } = await bestText(e);
  if (!text || text.length < 800) {
    failed.push({ id: e.id, reason: 'no-text', tried });
    skipped++;
    continue;
  }

  const mentioned = CHARGE_CATALOG.filter(c => new RegExp(String.raw`(?:Art\.|art\.)\s*${c.art}\b`, 'i').test(text));
  if (!mentioned.length) {
    failed.push({ id: e.id, reason: 'no-catalog-hit' });
    skipped++;
    continue;
  }

  const answers = await decide({
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'Swiss criminal / workplace-safety court decision. For each provision, mark charge_basis if it appears in the Anklage, Strafbefehl or Schuldspruch as an offence a defendant was charged with or convicted of — including eventualiter/hilfsweise alternatives that were charged. Mark mentioned_only for procedure (BGG/BV), Art. 12 StGB negligence definition, or other background cites. The site should list every charged offence provision.' },
      { type: 'input_json', data: { id: e.id, title: e.title?.de || '', text: text.slice(0, 50000) } },
    ] }],
    questions: mentioned.map(c => ({
      type: 'choice',
      name: c.id,
      instructions: `${c.label} (${c.hint}). charge_basis, mentioned_only, or absent?`,
      choices,
    })),
  });

  const basis = mentioned.filter(c => answers[c.id]?.choice === 'charge_basis');
  if (!basis.length) {
    failed.push({ id: e.id, reason: 'no-charge-basis', mentioned: mentioned.map(c => c.id), answers: Object.fromEntries(mentioned.map(c => [c.id, answers[c.id]?.choice])) });
    skipped++;
    continue;
  }

  const deLabels = basis.map(c => absFromText(text, c.art, c.code));
  for (const d of e.defendants || []) {
    if (!d.charge?.de?.trim()) continue;
    d.charge = withCite(d.charge, deLabels);
  }
  // Persist entscheidsuche mirror when we used it and source was bger
  const mirror = entscheidsucheUrls(e).find(u => /entscheidsuche/.test(u));
  if (mirror && /bger\.ch/.test(e.source?.url || '') && !(e.extraSources || []).some(s => s.url === mirror)) {
    e.extraSources = [...(e.extraSources || []), { name: 'entscheidsuche.ch', url: mirror, lang: 'de' }];
  }
  updated++;
  console.log(`  ${e.id}: ${deLabels.join('; ')}`);
}

if (!DRY) fs.writeFileSync(PATH, JSON.stringify(rulings, null, 1) + '\n');
flush({ script: 'enrich-ruling-articles', dry: DRY, updated, skipped });
console.log(JSON.stringify({ dry: DRY, updated, skipped, failed }, null, 2));
