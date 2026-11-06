#!/usr/bin/env node
// Drafts data/rulings.json-shaped entries for queue rulings labelled keep=true by classify.mjs.
// Fetches the public decision text (robots-respecting, cached), asks the model for a strict-schema draft and writes
// data/drafts/rulings/<id>.json (gitignored). Never touches data/rulings.json: a reviewer publishes drafts.
// Env: LLM_DRAFT_MODEL (gpt-6-luna), DRAFT_MAX (5 per run), DRAFT_INCLUDE_PUBLISHED=1 (also redraft items already
// published, for evaluation), DRAFT_ONLY=<substring of url/title>. Skips cleanly without OPENAI_API_KEY.
import fs from 'node:fs';
import { obj, nul, L, DEFENDANT, CASE_STATUS, REMAND_SCOPE } from './lib/legal-model.mjs';
import { extract, flush, available, hash, LlmCapReached, LlmUnavailable } from './lib/llm.mjs';
import { getText } from './lib/fetch-text.mjs';
import { findPublished } from './lib/published.mjs';

const D = new URL('../data/', import.meta.url), OUT = new URL('drafts/rulings/', D);
if (!available()) { console.warn('draft:rulings: OPENAI_API_KEY missing – skipping.'); process.exit(0); }
if (!fs.existsSync(new URL('queue.json', D))) process.exit(0);
const queue = JSON.parse(fs.readFileSync(new URL('queue.json', D)));
const rulings = JSON.parse(fs.readFileSync(new URL('rulings.json', D)));
const MODEL = process.env.LLM_DRAFT_MODEL || 'gpt-6-luna', MAX = Number(process.env.DRAFT_MAX || 5);

const SCHEMA = obj({
  slug: { type: 'string', description: 'one or two lowercase German keywords for the hazard/object, e.g. kranlastwagen, dach, bagger' },
  date: { type: 'string', description: 'decision date YYYY-MM-DD' }, accidentDate: nul({ type: 'string' }),
  canton: { type: 'string' }, place: nul({ type: 'string' }),
  industry: { type: 'string', enum: ['construction', 'industry', 'agriculture', 'transport', 'forestry', 'logistics', 'energy', 'services', 'other'] },
  hazard: { type: 'string', enum: ['fall', 'crane', 'struck', 'machinery', 'vehicle', 'electrical', 'explosion', 'hazmat', 'other'] },
  outcome: nul({ type: 'string', enum: ['injured', 'serious', 'life_threatening', 'fatal'] }),
  judgmentDate: nul({type:'string'}), court: nul(L), caseNumber: nul({ type: 'string' }), final: nul({ type: 'boolean' }), appeal: nul(L), employerRole: nul(L),
  caseStatus: CASE_STATUS, remandScope: REMAND_SCOPE,
  defendants: { type: 'array', items: DEFENDANT },
  title: L, facts: obj({ activity: nul(L), what: L, injuries: nul(L) }), why: nul(L),
});
const SYS = `You draft entries for Safety Radar (safetyradar.ch), a Swiss site on workplace accidents and the court rulings that follow.
Return one ruling entry from the decision text. House rules:
- Facts only, taken from the source. If a fact is not stated, use null. Never guess and never write placeholders such as "unknown", "not reported" or "not stated in the source".
- Write in your own words: short, plain, news style. Do not translate or closely paraphrase sentences of the decision.
- No names of private persons (defendants, victims, witnesses, lawyers). Describe by role ("site manager", "crane operator"). Companies only by type ("roofing firm").
- Every text field in German (de, Swiss spelling with ss), French, Italian and English, same content in each.
- title: what happened + what the court decided, max ~90 characters. facts.what: 1-3 sentences on the accident. facts.injuries: one short phrase stating the injuries described in THIS decision: body part, injury type and severity/lasting effects only when stated, or fatal. Preserve relevant detail (e.g. multiple cuts to the left hand and forearm), not just "seriously injured" when the decision gives specifics. Use null only if injuries are truly absent from the text; never infer a diagnosis from the accident mechanism or offence. Same meaning in all four languages.
- appeal: the procedural path (lower courts with dates, what this court did). why: the court's key reasoning in 2-4 sentences.
- defendants: one per accused person, stable id d1, d2 etc. Use allegations [{status,offence:{de,fr,it,en},articles:[{code,article,paragraph,letter}]} instead of charge. Each allegation belongs ONLY to this source person. Status is convicted, acquitted, dismissed, open, alternative_charge (eventualiter, never a conviction), or reported (only a report, no confirmed disposition). Offence text has NO inline articles; put source-named provisions into structured articles. Never distribute case-level articles across defendants. Outcome is null if an actual injury/outcome is not established; a bodily-injury allegation alone does not establish injury severity. One offence per allegation. remandScope: criminal|civil|costs|mixed|unknown when remanded, null otherwise. Costs/civil-only remands do not reopen criminal guilt. caseStatus: resolved|remanded|investigation|appeal_pending|unknown describes the case separately from finality of this court decision. For each person: role, allegations (only person-specific source-confirmed offence provisions, not duty/procedure citations), verdict, reasoning, sanction, short (one line). If the source does not name an article, omit the parenthetical — never guess.
  Day-fines: dailyUnits = number of day-fines, dailyAmount = CHF per day-fine; suspended + probationYears if stated. fineCHF = additional fine (Busse). sanction only for a current conviction. sanctionHistory [{stage,date,sanction}] explicitly distinguishes contested_penalty_order, quashed_judgment and superseded_judgment; an appealed penalty order is not a prior conviction. Never infer an unknown stage. why must state the accepted decisive reason, not a rejected appeal ground. Hold a draft with contradictory essential source facts for editorial review.
- employerRole: which firms were involved and whether they were charged.
- Do not write a prevention lesson or catalog ref for rulings. Title/facts describe what happened and the court outcome.
- judgmentDate: actual court judgment date, YYYY-MM-DD, YYYY-MM or YYYY only when that precision is stated; null if not established. Never substitute an article publication date. accidentDate likewise retains only source-supported precision. date remains the existing record/sorting date.
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
    const { slug, date, ...rest } = d;
    const lesson = null;
    // published: release date shown by the source (bger.ch day list / article metadata / RSS pubDate), else null.
    // firstSeen: the day we first fetched the item – a separate fallback, never a publication date.
    const pub = await findPublished({ ...d, source: { url: x.url } });
    if (!pub.published && x.published && !/entscheidsuche/.test(x.source || '')) Object.assign(pub, { published: x.published, publishedSource: 'feed pubDate' });
    const firstSeen = new Date(x.fetchedAt || Date.now()).toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
    const entry = { id, date, published: pub.published, publishedSource: pub.publishedSource, firstSeen,
      caseId: `case-${d.accidentDate || d.date}-${d.canton?.toLowerCase()}-${d.slug}`, ...rest, lesson, linkedAccidentId: null,
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
