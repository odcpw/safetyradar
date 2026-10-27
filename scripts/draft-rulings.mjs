#!/usr/bin/env node
// Drafts data/rulings.json-shaped entries for queue rulings labelled keep=true by classify.mjs.
// Fetches the public decision text (robots-respecting, cached), asks the model for a strict-schema draft and writes
// data/drafts/rulings/<id>.json (gitignored). Never touches data/rulings.json: a reviewer publishes drafts.
// Env: LLM_DRAFT_MODEL (gpt-6-luna), DRAFT_MAX (5 per run), DRAFT_INCLUDE_PUBLISHED=1 (also redraft items already
// published, for evaluation), DRAFT_ONLY=<substring of url/title>. Skips cleanly without OPENAI_API_KEY.
import fs from 'node:fs';
import { extract, flush, available, hash, LlmCapReached, LlmUnavailable } from './lib/llm.mjs';
import { getText } from './lib/fetch-text.mjs';

const D = new URL('../data/', import.meta.url), OUT = new URL('drafts/rulings/', D);
if (!available()) { console.warn('draft:rulings: OPENAI_API_KEY missing – skipping.'); process.exit(0); }
if (!fs.existsSync(new URL('queue.json', D))) process.exit(0);
const queue = JSON.parse(fs.readFileSync(new URL('queue.json', D)));
const rulings = JSON.parse(fs.readFileSync(new URL('rulings.json', D)));
const MODEL = process.env.LLM_DRAFT_MODEL || 'gpt-6-luna', MAX = Number(process.env.DRAFT_MAX || 5);

const nul = s => ({ anyOf: [s, { type: 'null' }] });
const L = { type: 'object', additionalProperties: false, required: ['de', 'fr', 'it', 'en'], properties: { de: { type: 'string' }, fr: { type: 'string' }, it: { type: 'string' }, en: { type: 'string' } } };
const obj = props => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
const SANCTION = obj({ dailyUnits: nul({ type: 'integer' }), dailyAmount: nul({ type: 'integer' }), suspended: nul({ type: 'boolean' }), probationYears: nul({ type: 'integer' }),
  fineCHF: nul({ type: 'integer' }), custodial: nul(L), costs: nul(L), compensation: nul(L), bail: nul(L), other: nul(L) });
const SCHEMA = obj({
  slug: { type: 'string', description: 'one or two lowercase German keywords for the hazard/object, e.g. kranlastwagen, dach, bagger' },
  date: { type: 'string', description: 'decision date YYYY-MM-DD' }, accidentDate: nul({ type: 'string' }),
  canton: { type: 'string' }, place: nul({ type: 'string' }),
  industry: { type: 'string', enum: ['construction', 'industry', 'agriculture', 'transport', 'forestry', 'logistics', 'energy', 'services', 'other'] },
  hazard: { type: 'string', enum: ['fall', 'crane', 'struck', 'machinery', 'vehicle', 'electrical', 'explosion', 'hazmat', 'other'] },
  outcome: { type: 'string', enum: ['injured', 'serious', 'life_threatening', 'fatal'] },
  court: nul(L), caseNumber: nul({ type: 'string' }), final: nul({ type: 'boolean' }), appeal: nul(L), employerRole: nul(L),
  defendants: { type: 'array', items: obj({ role: L, charge: nul(L), verdict: { type: 'string', enum: ['convicted', 'acquitted', 'open', 'dismissed'] },
    reasoning: nul(L), sanction: nul(SANCTION), priorSanction: nul(SANCTION), short: nul(L) }) },
  title: L, facts: obj({ activity: nul(L), what: L, injuries: nul(L) }), why: nul(L), lesson: L,
});
const SYS = `You draft entries for Safety Radar (safetyradar.ch), a Swiss site on workplace accidents and the court rulings that follow.
Return one ruling entry from the decision text. House rules:
- Facts only, taken from the source. If a fact is not stated, use null. Never guess and never write placeholders such as "unknown", "not reported" or "not stated in the source".
- Write in your own words: short, plain, news style. Do not translate or closely paraphrase sentences of the decision.
- No names of private persons (defendants, victims, witnesses, lawyers). Describe by role ("site manager", "crane operator"). Companies only by type ("roofing firm").
- Every text field in German (de, Swiss spelling with ss), French, Italian and English, same content in each.
- title: what happened + what the court decided, max ~90 characters. facts.what: 1-3 sentences on the accident. facts.injuries: the injuries.
- appeal: the procedural path (lower courts with dates, what this court did). why: the court's key reasoning in 2-4 sentences.
- defendants: one per accused person: role, charge (offence + article, e.g. "Fahrlässige schwere Körperverletzung (Art. 125 StGB)"), verdict, reasoning (why convicted/acquitted), sanction, short (one line).
  Day-fines: dailyUnits = number of day-fines, dailyAmount = CHF per day-fine; suspended + probationYears if stated. fineCHF = additional fine (Busse). priorSanction = lower-court sanction if this court changed it.
- employerRole: which firms were involved and whether they were charged.
- lesson: 1-2 practical prevention sentences for employers/workers, no heading, no "Lesson:" prefix.
- court: the court name (e.g. Bundesgericht / Tribunal fédéral / Tribunale federale / Federal Supreme Court). final: true if no further appeal possible (Federal Court) or stated as final.`;

const COURTS = [[/obergericht/i, 'og'], [/kantonsgericht/i, 'kg'], [/bezirksgericht/i, 'bezg'], [/regionalgericht/i, 'rg'], [/strafgericht/i, 'strafg'],
  [/cour de justice|justizhof/i, 'cj'], [/kantonsgericht|tribunal cantonal/i, 'tc'], [/polizeigericht|tribunal de police/i, 'tp'], [/appell/i, 'ta'], [/staatsanwalt|ministère public|ministero pubblico/i, 'sta']];
const courtAbbr = s => s ? (COURTS.find(([re]) => re.test(s)) || [null, null])[1] : null;
const examples = rulings.slice(-2).map(({ id, caseId, source, extraSources, linkedAccidentId, ...e }) => e);
const published = new Set(rulings.flatMap(r => [r.source?.url, ...(r.extraSources || []).map(s => s.url)]));
let todo = queue.filter(x => x.llm?.keep && x.llm.type === 'ruling' && x.url)
  .filter(x => process.env.DRAFT_INCLUDE_PUBLISHED || (!x.llm.dupOf?.match(/^\d{4}-/) && !published.has(x.url)))
  .filter(x => !process.env.DRAFT_ONLY || (x.url + x.title).includes(process.env.DRAFT_ONLY))
  .filter(x => !x.draftPath || !fs.existsSync(new URL('../' + x.draftPath, D)));
console.log(`draft:rulings: ${todo.length} rulings to draft (max ${MAX}) with ${MODEL}.`);
fs.mkdirSync(OUT, { recursive: true });
let n = 0, stopped = null;
try {
  for (const x of todo.slice(0, MAX)) {
    const text = await getText(x.url);
    if (!text || text.length < 1500) { console.warn(`  skip (no usable text): ${x.url}`); x.draftNote = 'no fetchable text (news report?) – draft manually'; continue; }
    const d = await extract({ system: SYS, model: MODEL, name: 'ruling', schema: SCHEMA, effort: process.env.LLM_EFFORT_DRAFT || 'medium',
      input: `Two published entries, for format and tone only:\n${JSON.stringify(examples)}\n\nSource: ${x.url}\nDecision text:\n${text.slice(0, 60000)}` });
    const fed = /bundesgericht|tribunal fédéral|federal supreme/i.test(`${d.court?.de} ${d.court?.fr} ${d.court?.en}`);
    const cn = (d.caseNumber || '').split(/[,;]|\s(?:et|und|e)\s/)[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const cant = d.canton?.toLowerCase();
    const id = (fed ? [d.date, 'bger', cn, cant, d.slug] : [d.date, cant, courtAbbr(d.court?.de), cn, d.slug]).filter(Boolean).join('-').replace(/-+/g, '-');
    const { slug, ...rest } = d;
    const entry = { id, caseId: `case-${d.accidentDate || d.date}-${d.canton?.toLowerCase()}-${d.slug}`, ...rest, linkedAccidentId: null,
      source: { name: new URL(x.url).hostname.replace(/^www\./, ''), url: x.url, lang: x.lang === 'multi' ? null : x.lang }, extraSources: [],
      _draft: { model: MODEL, effort: process.env.LLM_EFFORT_DRAFT || 'medium', at: new Date().toISOString(), queueKey: hash(x.url), dedupeHint: x.llm.dupOf || null, note: 'LLM draft – verify every fact against the source before publishing; remove _draft.' } };
    const file = new URL(`${id}.json`, OUT);
    fs.writeFileSync(file, JSON.stringify(entry, null, 1));
    x.draftPath = `data/drafts/rulings/${id}.json`; n++;
    console.log(`  drafted ${x.draftPath}`);
  }
} catch (e) { stopped = e.message; console.warn('draft:rulings stopped:', e.message); }
fs.writeFileSync(new URL('queue.json', D), JSON.stringify(queue, null, 2));
flush({ drafted: n, model: MODEL, stopped });
