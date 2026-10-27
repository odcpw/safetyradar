#!/usr/bin/env node
// LLM labelling of data/queue.json. Stage 1: Decisions API (gpt-6-luna) sorts every unlabelled item into
// accident / ruling / other from title + source. Stage 2: for candidates, Responses API with a JSON schema
// extracts canton, place, date, industry, outcome, reason and a dedupe hint against published entries.
// Labels are stored on the item as item.llm (keyed by url hash) so they are never re-labelled.
// Env: LLM_FORCE=1 relabel all; LLM_BATCH (20); LLM_STAGE2_MIN (0.1, recall-oriented). Skips cleanly without OPENAI_API_KEY.
import fs from 'node:fs';
import { getText } from './lib/fetch-text.mjs';
import { decide, extract, flush, available, hash, LlmCapReached, LlmUnavailable } from './lib/llm.mjs';

const D = new URL('../data/', import.meta.url);
const read = f => JSON.parse(fs.readFileSync(new URL(f, D)));
if (!available()) { console.warn('classify: OPENAI_API_KEY missing – skipping LLM labelling.'); process.exit(0); }
if (!fs.existsSync(new URL('queue.json', D))) { console.warn('classify: no data/queue.json – nothing to do.'); process.exit(0); }

const queue = read('queue.json');
const save = () => fs.writeFileSync(new URL('queue.json', D), JSON.stringify(queue, (k, v) => k === '_redo' ? undefined : v, 2));
const BATCH = Number(process.env.LLM_BATCH || 20), MIN2 = Number(process.env.LLM_STAGE2_MIN || 0.1);
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const VERSION = 1;
const EFFORT = process.env.LLM_EFFORT_EXTRACT || 'low'; // none|low|medium|high|xhigh; low tested = medium accuracy, fewer output tokens
const VIA = process.env.LLM_FIELDS_VIA || 'responses'; // decisions: enumerable fields via /v1/decisions, free text via Responses
const isCourtDoc = x => x.source === 'entscheidsuche' && !/not a criminal|non-criminal/.test(x.reason || '');
const caseOf = ref => { const n = String(ref || '').replace(/\s+/g, ' ').trim().toLowerCase(); return n ? recentAll.find(e => String(e.caseNumber || '').toLowerCase().replace(/\s+/g, ' ').split(/,\s*/).includes(n)) : null; };

// Compact list of recent published entries for dedupe.
const recentAll = [...read('accidents.json'), ...read('rulings.json')];
const recent = [...read('accidents.json').map(a => ({ ...a, k: 'accident' })), ...read('rulings.json').map(r => ({ ...r, k: 'ruling' }))]
  .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 120)
  .map(e => ({ id: e.id, kind: e.k, date: e.date, canton: e.canton, place: e.place, case: e.caseNumber, title: e.title?.en, url: e.source?.url }));

// LLM_REDO_STAGE2=1: keep cached stage-1 sorts, redo field extraction (for comparing settings).
if (process.env.LLM_REDO_STAGE2) for (const x of queue) if (x.llm && (x.llm.stage === 2 || x.llm.stage === 'text')) {
  x.llm = x.llm.stage === 2 ? { v: VERSION, key: x.llm.key, stage: 1, type: x.llm.s1type, p: x.llm.s1p, keep: false } : null; x._redo = true; }
const todo = queue.filter(x => process.env.LLM_FORCE || x._redo || !x.llm || x.llm.key !== hash(x.url) || x.llm.v !== VERSION);
const needsStage1 = x => !(x._redo && x.llm?.stage === 1);
console.log(`classify: ${todo.length} of ${queue.length} queue items need labels.`);

const TYPE_CHOICES = [
  { value: 'accident', description: 'A concrete occupational accident in Switzerland: a person injured or killed while working (construction, forestry, farm work, factory, warehouse, maintenance, crane, scaffold, machine, electrical work, workers on a road site). Includes follow-up reports on such an accident.' },
  { value: 'ruling', description: 'A court decision, verdict, trial, penalty order or prosecution in Switzerland about a workplace accident or breach of workplace safety duties (employer, site manager, worker convicted/acquitted).' },
  { value: 'other', description: 'Anything else: road traffic, commuting, leisure, sport, mountain, household, school, crime, fire without a worker hurt, foreign (non-Swiss) events, administrative/social-insurance/tax/court cases not about workplace safety, general news.' },
];

async function stage1(batch) {
  const input = [{ role: 'user', content: [
    { type: 'input_text', text: 'News headlines and court-decision titles collected for a Swiss workplace-safety site. Each item has a number n. Judge each item separately using its title, source and URL host.' },
    { type: 'input_json', data: batch.map((x, n) => ({ n, title: x.title, source: x.sourceName || x.source, host: host(x.url), path: (() => { try { return new URL(x.url).pathname.slice(0, 120); } catch { return ''; } })(), date: x.date, feedKind: x.kind })) },
  ] }];
  const questions = batch.map((_, n) => ({ type: 'choice', name: `t${n}`, instructions: `Item n=${n}: what is it?`, choices: TYPE_CHOICES }));
  const ans = await decide({ input, questions });
  return batch.map((_, n) => {
    const a = ans[`t${n}`];
    if (!a || a.type !== 'choice') return { type: 'other', p: {}, refused: true };
    return { type: a.choice, confidence: a.confidence, p: Object.fromEntries(a.probabilities.map(o => [o.value, o.probability])) };
  });
}

const CANTONS = ['AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE','NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH'];
const S2 = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['n', 'type', 'keep', 'confidence', 'canton', 'place', 'date', 'industry', 'outcome', 'language', 'reason', 'dupOf'],
    properties: {
      n: { type: 'integer' },
      type: { type: 'string', enum: ['accident', 'ruling', 'other'] },
      keep: { type: 'boolean' },
      confidence: { type: 'number' },
      canton: { anyOf: [{ type: 'string', enum: CANTONS }, { type: 'null' }] },
      place: { type: ['string', 'null'] },
      date: { type: ['string', 'null'], description: 'YYYY-MM-DD of the accident/decision if stated or clearly implied, else null' },
      industry: { anyOf: [{ type: 'string', enum: ['construction', 'forestry', 'agriculture', 'logistics', 'manufacturing', 'energy', 'chemicals', 'transport', 'public', 'services', 'other'] }, { type: 'null' }] },
      outcome: { type: 'string', enum: ['fatal', 'injured', 'none', 'unknown'] },
      language: { type: 'string', enum: ['de', 'fr', 'it', 'en', 'rm', 'other'] },
      reason: { type: 'string', description: 'max 15 words, English' },
      dupOf: { type: ['string', 'null'], description: 'id of a published entry (E list) or "q:<n>" of another item in this batch describing the same event/case, else null' },
    } } } },
};
const SYS = `You label items for Safety Radar, a site about Swiss occupational (workplace) accidents and court rulings on workplace safety.
keep=true only for: a real occupational accident in Switzerland (someone hurt/killed while working), or a Swiss court ruling / penalty order / trial about such an accident or workplace safety duties.
keep=false for: road traffic and commuting (unless a worker on a work site/vehicle at work), leisure, sport, mountain, household, school, crime, non-Swiss events, insurance/tax/administrative cases, opinion pieces, statistics.
Use only facts in the item; unknown -> null / "unknown". Canton: 2-letter code. dupOf: the id from the E list if it is clearly the same event or case (same place/date/case number), or "q:<n>" for an earlier item in this batch; otherwise null.`;

async function stage2(batch) {
  const items = batch.map((x, n) => ({ n, title: x.title, source: x.sourceName || x.source, url: x.url, date: x.date, ref: x.reference }));
  const out = await extract({ system: SYS, name: 'labels', schema: S2, effort: EFFORT,
    input: `E (published entries):\n${JSON.stringify(recent)}\n\nItems:\n${JSON.stringify(items)}` });
  return out.items;
}

// ---- LLM_FIELDS_VIA=decisions: enumerable fields as Decisions questions (output free), free text via a small Responses call.
const INDUSTRIES = S2.properties.items.items.properties.industry.anyOf[0].enum;
const ch = (vals, desc = {}) => vals.map(v => ({ value: v, ...(desc[v] ? { description: desc[v] } : {}) }));
const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 864e5);
function dupCandidates(x, earlier) {
  const d = x.date || new Date().toISOString().slice(0, 10);
  const pub = recentAll.filter(e => e.date && dayDiff(e.date, d) <= 14 || (x.reference && String(e.caseNumber || '').includes(x.reference)) || (e.accidentDate && dayDiff(e.accidentDate, d) <= 14))
    .sort((a, b) => dayDiff(a.date, d) - dayDiff(b.date, d)).slice(0, 8)
    .map(e => ({ value: e.id, description: `${e.date} ${e.canton} ${e.place ?? ''} ${e.caseNumber ?? ''} ${e.title?.en ?? ''}`.slice(0, 160) }));
  const q = earlier.filter(o => o.date && dayDiff(o.date, d) <= 3).slice(-6).map(o => ({ value: 'queue:' + hash(o.url), description: `${o.date} ${o.title}`.slice(0, 160) }));
  return [...pub, ...q, { value: 'none', description: 'None of these: a different event or case.' }];
}
const KEEP_Q = 'Should Safety Radar keep this? True only for a real occupational accident in Switzerland (someone hurt or killed while working), or a Swiss court ruling / penalty order / trial about such an accident or workplace-safety duties. False for road traffic/commuting (unless a worker at work), leisure, sport, household, crime, non-Swiss events, insurance/tax/administrative cases.';
async function fieldsDecisions(items, earlierAll, textMode) {
  const input = [{ role: 'user', content: [
    { type: 'input_text', text: textMode ? 'A Swiss court decision (full text excerpt). Judge whether it concerns a workplace accident or workplace-safety duties.' : 'News items for a Swiss workplace-safety site, each with a number n. Judge each item separately; use only what the item states.' },
    { type: 'input_json', data: items.map((x, n) => ({ n, title: x.title, source: x.sourceName || x.source, url: x.url, date: x.date, ref: x.reference, ...(x._text ? { text: x._text } : {}) })) }] }];
  const qs = [];
  items.forEach((x, n) => {
    const it = `Item n=${n}: `;
    qs.push({ type: 'predicate', name: `keep${n}`, instructions: it + KEEP_Q });
    qs.push({ type: 'choice', name: `type${n}`, instructions: it + 'what is it?', choices: TYPE_CHOICES });
    qs.push({ type: 'choice', name: `canton${n}`, instructions: it + 'in which Swiss canton did it happen / which canton is the court in? unknown if not stated or not inferable from a named place.', choices: ch([...CANTONS, 'unknown']) });
    qs.push({ type: 'choice', name: `industry${n}`, instructions: it + 'industry of the work involved (unknown if not clear).', choices: ch([...INDUSTRIES, 'unknown']) });
    qs.push({ type: 'choice', name: `outcome${n}`, instructions: it + 'worst outcome for the victim.', choices: ch(['fatal', 'injured', 'none', 'unknown'], { injured: 'injured (any severity), not dead', none: 'nobody hurt', unknown: 'not stated' }) });
    qs.push({ type: 'choice', name: `language${n}`, instructions: it + 'language of the item.', choices: ch(['de', 'fr', 'it', 'en', 'other']) });
    const dc = dupCandidates(x, earlierAll.concat(items.slice(0, n)));
    if (dc.length > 1) qs.push({ type: 'choice', name: `dup${n}`, instructions: it + 'is this the same event or court case as one of these (same place, date, people or case number)?', choices: dc });
  });
  const a = await decide({ input, questions: qs });
  const val = (k, map = v => v) => a[k]?.type === 'choice' ? map(a[k].choice) : null;
  return items.map((x, n) => ({ n, keep: (a[`keep${n}`]?.probability ?? 0) >= 0.5, confidence: a[`keep${n}`]?.probability ?? 0,
    type: val(`type${n}`) || 'other', canton: val(`canton${n}`, v => v === 'unknown' ? null : v), industry: val(`industry${n}`, v => v === 'unknown' ? null : v),
    outcome: val(`outcome${n}`) || 'unknown', language: val(`language${n}`) || 'other', dupOf: val(`dup${n}`, v => v === 'none' ? null : v) }));
}
const S_FREE = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false,
  required: ['n', 'place', 'date', 'reason'], properties: { n: { type: 'integer' }, place: S2.properties.items.items.properties.place, date: S2.properties.items.items.properties.date, reason: S2.properties.items.items.properties.reason } } } } };
async function freeText(items) {
  const out = await extract({ system: 'Extract for each item: place (municipality/locality where it happened, null if not stated), date (YYYY-MM-DD of the event or decision if stated, else null), reason (max 15 words, English: what it is and why it does or does not concern a Swiss workplace accident/ruling). Facts only.',
    name: 'free', schema: S_FREE, effort: EFFORT, input: JSON.stringify(items.map((x, n) => ({ n, title: x.title, url: x.url, date: x.date, ...(x._text ? { text: x._text.slice(0, 6000) } : {}) }))) });
  return out.items;
}
async function labelViaDecisions(items, earlierAll, textMode) {
  const f = await fieldsDecisions(items, earlierAll, textMode);
  const keptIdx = f.filter(l => l.keep || l.type !== 'other').map(l => l.n);
  const ft = keptIdx.length ? await freeText(keptIdx.map(n => items[n])) : [];
  for (const t of ft) { const l = f[keptIdx[t.n]]; if (l) Object.assign(l, { place: t.place, date: t.date, reason: t.reason }); }
  return f.map(l => ({ place: null, date: null, reason: l.keep ? '' : 'not kept (decisions)', ...l }));
}

let s1 = 0, s2 = 0, stopped = null;
try {
  const court = todo.filter(isCourtDoc), news = todo.filter(x => !isCourtDoc(x));
  const s1todo = news.filter(needsStage1);
  for (const x of court) {
    const text = await getText(x.url);
    if (text && VIA === 'decisions') x._text = text.slice(0, 12000);
    const l = text && VIA === 'decisions' ? (await labelViaDecisions([x], [], true))[0] : text ? (await extract({ system: SYS + '\nThis item is a full court decision; judge from its text whether it concerns a workplace accident or workplace-safety duties. If it does, type=ruling.',
      name: 'labels', schema: S2, effort: EFFORT, input: `E (published entries):\n${JSON.stringify(recent)}\n\nItems:\n${JSON.stringify([{ n: 0, title: x.title, ref: x.reference, url: x.url, text: text.slice(0, 12000) }])}` })).items[0]
      : { type: 'ruling', keep: true, confidence: 0, reason: 'text not fetchable – review manually', canton: null, place: null, date: x.date, industry: null, outcome: 'unknown', language: x.lang, dupOf: null };
    const hit = caseOf(x.reference); if (hit) l.dupOf = hit.id;
    delete l.n; delete x._text; x.llm = { v: VERSION, key: hash(x.url), at: new Date().toISOString(), stage: 'text', via: text ? VIA : null, ...l };
    s2++; save();
  }
  for (let i = 0; i < s1todo.length; i += BATCH) {
    const b = s1todo.slice(i, i + BATCH);
    const r = await stage1(b);
    b.forEach((x, n) => { x.llm = { v: VERSION, key: hash(x.url), at: new Date().toISOString(), stage: 1, ...r[n], keep: false }; });
    s1 += b.length; save();
  }
  const cands = news.filter(x => x.llm && x.llm.stage === 1 && Math.max(x.llm.p.accident || 0, x.llm.p.ruling || 0) >= MIN2);
  console.log(`classify: stage 1 done (${s1}); ${cands.length} candidates for stage 2.`);
  for (let i = 0; i < cands.length; i += 10) {
    const b = cands.slice(i, i + 10);
    const r = VIA === 'decisions' ? await labelViaDecisions(b, cands.slice(0, i), false) : await stage2(b);
    for (const l of r) {
      const x = b[l.n]; if (!x) continue;
      if (l.dupOf?.startsWith('q:')) { const o = b[+l.dupOf.slice(2)]; l.dupOf = o ? `queue:${hash(o.url)}` : null; }
      x.llm = { ...x.llm, ...l, stage: 2, via: VIA, s1type: x.llm.type, s1p: x.llm.p };
      delete x.llm.n; delete x.llm.p;
      s2++;
    }
    save();
  }
} catch (e) {
  if (e instanceof LlmCapReached || e instanceof LlmUnavailable) stopped = e.message; else { stopped = e.message; console.error('classify error:', e.message); }
}
save();
flush({ labelled1: s1, labelled2: s2, stopped });
if (stopped) console.warn(`classify: stopped early (${stopped}); remaining items will be labelled next run.`);
console.log(`classify: kept ${queue.filter(x => x.llm?.keep).length} items in total.`);
