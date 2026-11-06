import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LANGS = ['de', 'fr', 'it', 'en'];
export const LEGAL_STATUSES = ['convicted', 'acquitted', 'dismissed', 'open', 'alternative_charge', 'reported'];
export const CASE_STATUSES = ['resolved', 'remanded', 'investigation', 'appeal_pending', 'unknown'];
export const REMAND_SCOPES = ['criminal','civil','costs','mixed','unknown'];
export const HISTORY_STAGES = ['contested_penalty_order', 'quashed_judgment', 'superseded_judgment'];
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
export const fingerprint = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
export const reviewKey = (kind, id) => `${kind}/${id}`;
export const ledgerPath = root => path.join(root, 'editorial', 'review-ledger.json');
export const readLedger = root => fs.existsSync(ledgerPath(root)) ? JSON.parse(fs.readFileSync(ledgerPath(root), 'utf8')) : {};
export function writeLedger(root, ledger) {
  fs.mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
  fs.writeFileSync(ledgerPath(root), JSON.stringify(ledger, null, 1) + '\n');
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  return y >= 1900 && (m == null || m >= 1 && m <= 12) && (d == null || d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate());
}
const INTERNAL_KEYS = new Set(['evidence','sourceHash','sourcePerson','legacySnapshot','publicationEvidence','semanticReview','decisions','paragraphIds','quotes']);
export function internalFieldPaths(value, prefix='') {
 if(!value || typeof value!=='object')return [];
 return Object.entries(value).flatMap(([k,v])=>[...(INTERNAL_KEYS.has(k)?[prefix+'/'+k]:[]),...internalFieldPaths(v,prefix+'/'+k)]);
}
export function structuralErrors(entry, kind) {
  const errors = internalFieldPaths(entry).map(p=>'internal verification field must not be public: '+p);
  if (entry.outcome !== 'fatal' && /\belectrocut(?:ed|ion)\b/i.test([entry.title?.en, ...Object.values(entry.facts || {}).map(v => v?.en)].join(' '))) errors.push('nonfatal electric shock translated as fatal electrocution');
  if (!Object.hasOwn(entry,'accidentDate')) errors.push('explicit accidentDate or null required; never infer from record date');
  if (entry.judgmentDate != null && !validDate(entry.judgmentDate)) errors.push('invalid judgment date');
  if (kind === 'rulings' && !Object.hasOwn(entry,'judgmentDate')) errors.push('explicit judgmentDate or null required');
  if (entry.accidentDate != null && !validDate(entry.accidentDate)) errors.push('invalid accident date');
  if (entry.casualties != null) {
    for (const k of ['fatal', 'injured', 'checked']) if (entry.casualties[k] != null && (!Number.isInteger(entry.casualties[k]) || entry.casualties[k] < 0)) errors.push(`invalid casualty count ${k}`);
    if (entry.casualties.fatal > 0 && entry.outcome !== 'fatal') errors.push('fatal count conflicts with outcome');
    if (entry.outcome === 'property' && (entry.casualties.fatal > 0 || entry.casualties.injured > 0)) errors.push('property-only outcome conflicts with casualties');
  }
  if (kind !== 'rulings') return errors;
  if (entry.lesson != null) errors.push('rulings must not have prevention lessons');
  if (!CASE_STATUSES.includes(entry.caseStatus)) errors.push('caseStatus required');
  if(entry.caseStatus==='remanded'&&!REMAND_SCOPES.includes(entry.remandScope))errors.push('remanded case requires explicit criminal/civil/costs scope');
  if(entry.caseStatus!=='remanded'&&entry.remandScope!=null)errors.push('remandScope without a remand');
  const ids = new Set();
  for (const [i, defendant] of (entry.defendants || []).entries()) {
    if (!defendant.id || ids.has(defendant.id)) errors.push(`defendant ${i}: unique id required`);
    ids.add(defendant.id);
    if ('charge' in defendant || 'priorSanction' in defendant) errors.push(`defendant ${i}: deprecated unscoped charge/priorSanction`);
    if (!Array.isArray(defendant.allegations)) { errors.push(`defendant ${i}: allegations required`); continue; }
    for (const [j, allegation] of defendant.allegations.entries()) {
      if (!LEGAL_STATUSES.includes(allegation.status)) errors.push(`defendant ${i} allegation ${j}: invalid status`);
      if (!LANGS.every(l => typeof allegation.offence?.[l] === 'string' && allegation.offence[l].trim())) errors.push(`defendant ${i} allegation ${j}: four-language offence required`);
      if (LANGS.some(l => /\b(?:Art\.|art\.)\s*\d/.test(allegation.offence?.[l] || ''))) errors.push(`defendant ${i} allegation ${j}: articles belong in structured articles, not offence text`);
      if (allegation.status === 'convicted' && defendant.verdict !== 'convicted') errors.push(`defendant ${i}: convicted allegation conflicts with disposition`);
      if (!Array.isArray(allegation.articles)) errors.push(`defendant ${i} allegation ${j}: articles required`);
      for (const a of allegation.articles || []) if (!['StGB', 'UVG', 'BauAV', 'VUV', 'ArG'].includes(a.code) || !/^\d+[a-z]?$/.test(a.article) || a.paragraph != null && !/^\d+[a-z]?$/.test(a.paragraph) || a.letter != null && !/^[a-z]$/.test(a.letter)) errors.push(`defendant ${i} allegation ${j}: invalid provision`);
    }
    if (defendant.verdict !== 'convicted' && defendant.sanction && Object.entries(defendant.sanction).some(([k, v]) => v != null)) errors.push(`defendant ${i}: non-conviction cannot carry a current sanction`);
    for (const h of defendant.sanctionHistory || []) if (!HISTORY_STAGES.includes(h.stage) || !h.sanction || h.date != null && !validDate(h.date)) errors.push(`defendant ${i}: invalid historical sanction stage`);
  }
  return errors;
}
export function evidenceErrors(entry, kind, evidence) {
  const errors = [];
  if (!Array.isArray(evidence) || !evidence.length) return ['source evidence required'];
  if (kind === 'rulings') for (const [i, d] of (entry.defendants || []).entries()) for (const [j, a] of (d.allegations || []).entries()) {
    const found = evidence.filter(e => e.path === `/defendants/${i}/allegations/${j}` && e.personId === d.id && e.sourcePerson && e.section && e.quotes?.length);
    if (!found.length) errors.push(`missing person-bound evidence for ${d.id} allegation ${j}`);
  }
  if (kind === 'accidents') for (const [i] of (entry.lesson?.refs || []).entries()) {
    for (const part of ['activity', 'prerequisites']) if (!evidence.some(e => e.topic === 'lessons' && e.path === `/lesson/refs/${i}/${part}` && e.quotes?.length && e.section)) errors.push(`lesson ${i}: missing source-bound ${part} evidence`);
  }
  const bindings = new Map();
  for (const e of evidence.filter(e => e.personId && e.sourcePerson)) {
    const key = e.sourceUrl + ':' + e.sourcePerson.trim().toLowerCase();
    if (bindings.has(key) && bindings.get(key) !== e.personId) errors.push('one source person mapped to different defendants');
    bindings.set(key, e.personId);
  }
  for (const e of evidence) if (!e.sourceUrl || !e.sourceHash || !e.quotes?.length || e.quotes.some(q => !q.trim())) errors.push(`incomplete source evidence at ${e.path}: url=${!!e.sourceUrl}, hash=${!!e.sourceHash}, quotes=${e.quotes?.length ?? 0}, emptyQuote=${e.quotes?.some(q=>!q.trim()) ?? true}`);
  return errors;
}
export function ledgerErrors(root, itemsByKind, ledger = readLedger(root)) {
  const errors = [];
  for (const [kind, entries] of Object.entries(itemsByKind)) for (const e of entries) {
    const r = ledger[reviewKey(kind, e.id)];
    if (!r || r.hash !== fingerprint(e)) { errors.push(`${kind}/${e.id}: missing or stale review; hold changes before publication`); continue; }
    if (!['verified', 'legacy_unreviewed'].includes(r.state)) errors.push(`${kind}/${e.id}: review state cannot be published`);
    if (r.state === 'verified' && kind === 'rulings' && e.published && (r.publicationEvidence?.status !== 'confirmed' || r.publicationEvidence.published !== e.published || r.publicationEvidence.publishedSource !== e.publishedSource)) errors.push(`${e.id}: native publication metadata proof missing or mismatched`);
    if (r.state === 'verified') errors.push(...structuralErrors(e, kind).map(s => `${e.id}: ${s}`), ...evidenceErrors(e, kind, r.evidence).map(s => `${e.id}: ${s}`));
  }
  return errors;
}

// A rejected candidate is never written into the published collection. Held updates leave the previous object intact.
export async function gateCollection({ kind, before, candidates, verify, onHold }) {
  const previous = new Map(before.map(e => [e.id, e]));
  const accepted = [], results = [];
  for (const candidate of candidates) {
    const old = previous.get(candidate.id);
    if (old && fingerprint(old) === fingerprint(candidate)) { accepted.push(old); continue; }
    let result;
    try { result = await verify(candidate, old); } catch (e) { result = { state: 'held', issues: [e.message] }; }
    results.push({ id: candidate.id, ...result });
    if (result.state === 'verified') accepted.push(candidate);
    else { if (old) accepted.push(old); await onHold?.({ kind, candidate, previous: old ?? null, ...result }); }
  }
  // Removal of a published accident/ruling is also held; it is not an agent's way around verification.
  for (const old of before) if (!candidates.some(e => e.id === old.id)) { accepted.push(old); await onHold?.({ kind, candidate: null, previous: old, state: 'held', issues: ['deletion requires explicit editorial review'] }); }
  return { accepted, results };
}
