#!/usr/bin/env node
// Validates the published content (data/accidents.json, rulings.json, jobs.json) against the data model in README.md
// and the house rules in docs/EDITORIAL.md that can be checked mechanically. Exit 1 on errors; warnings don't fail.
// Usage: node scripts/validate-data.mjs [dataDir]   (default: ./data)
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'data');
const LANGS = ['de', 'fr', 'it', 'en'];
const CANTONS = 'AG AI AR BE BL BS FR GE GL GR JU LU NE NW OW SG SH SO SZ TG TI UR VD VS ZG ZH'.split(' ');
const TAX = {
  industry: ['construction', 'forestry', 'chemicals', 'logistics', 'energy', 'agriculture', 'transport', 'cleaning', 'industry'],
  hazard: ['fall', 'struck', 'crane', 'machinery', 'vehicle', 'hazmat', 'explosion'],
  outcome: ['fatal', 'life_threatening', 'serious', 'injured', 'property'],
  role: ['asgs', 'hse', 'engineer', 'sibe'],
};
const JOB_MAX_AGE_DAYS = 60;
const errors = [], warnings = [];
const err = (f, id, m) => errors.push(`${f} ${id}: ${m}`);
const warn = (f, id, m) => warnings.push(`${f} ${id}: ${m}`);
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(v);
const isUrl = v => { try { return ['https:', 'http:'].includes(new URL(v).protocol); } catch { return false; } };
const t4 = (f, id, key, v, { required = false } = {}) => {
  if (v == null) { if (required) err(f, id, `${key} is required`); return; }
  if (typeof v !== 'object') return err(f, id, `${key} must be {de,fr,it,en} or null`);
  for (const l of LANGS) if (typeof v[l] !== 'string' || !v[l].trim()) err(f, id, `${key}.${l} missing/empty`);
};
const enumOrNull = (f, id, key, v, list) => { if (v != null && !list.includes(v)) err(f, id, `${key} "${v}" not in ${list.join('|')}`); };
const source = (f, id, key, s) => {
  if (!s || typeof s !== 'object') return err(f, id, `${key} missing`);
  if (!s.name) err(f, id, `${key}.name missing`);
  if (!isUrl(s.url)) err(f, id, `${key}.url invalid`);
  if (s.lang && !LANGS.includes(s.lang)) err(f, id, `${key}.lang "${s.lang}" invalid`);
};
const noDraftKeys = (f, id, v) => JSON.stringify(v).includes('"_draft"') && err(f, id, '_draft marker left in published entry');

function load(f) {
  try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (!Array.isArray(d)) throw new Error('not an array'); return d; }
  catch (e) { err(f, '-', `cannot parse: ${e.message}`); return []; }
}
function common(f, e, seen) {
  const id = e.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) err(f, id, 'id must be a lowercase slug');
  if (seen.has(id)) err(f, id, 'duplicate id'); seen.add(id);
  noDraftKeys(f, id, e);
  return id;
}
function event(f, e, id) {
  if (!isDate(e.date)) err(f, id, 'date must be YYYY-MM-DD');
  if (e.canton != null && !CANTONS.includes(e.canton)) err(f, id, `canton "${e.canton}" invalid`);
  for (const k of ['industry', 'hazard', 'outcome']) enumOrNull(f, id, k, e[k], TAX[k]);
  if (!e.caseId) err(f, id, 'caseId missing');
  source(f, id, 'source', e.source);
  (e.extraSources || []).forEach((s, i) => source(f, id, `extraSources[${i}]`, s));
  const urls = [e.source?.url, ...(e.extraSources || []).map(s => s.url)];
  if (new Set(urls).size !== urls.length) err(f, id, 'same URL listed twice in source/extraSources');
  t4(f, id, 'title', e.title, { required: true });
  t4(f, id, 'lesson', e.lesson, { required: true });
  for (const [k, v] of Object.entries(e.facts || {})) t4(f, id, `facts.${k}`, v);
  for (const l of LANGS) if (/^\s*(lesson|lehre|leçon|lezione)\s*[:–-]/i.test(e.lesson?.[l] || '')) err(f, id, `lesson.${l} starts with a heading`);
}

const accidents = load('accidents.json'), rulings = load('rulings.json'), jobs = load('jobs.json');
let seen = new Set();
for (const e of accidents) { const id = common('accidents.json', e, seen); event('accidents.json', e, id); }
seen = new Set();
for (const e of rulings) {
  const f = 'rulings.json', id = common(f, e, seen); event(f, e, id);
  if (e.accidentDate != null && !isDate(e.accidentDate)) err(f, id, 'accidentDate must be YYYY-MM[-DD] or null');
  for (const k of ['court', 'appeal', 'employerRole', 'why']) t4(f, id, k, e[k]);
  if (e.final != null && typeof e.final !== 'boolean') err(f, id, 'final must be true/false/null');
  if (e.linkedAccidentId != null && !accidents.some(a => a.id === e.linkedAccidentId)) err(f, id, `linkedAccidentId ${e.linkedAccidentId} not in accidents.json`);
  if (!Array.isArray(e.defendants)) { err(f, id, 'defendants must be an array'); continue; }
  e.defendants.forEach((d, i) => {
    if (d.verdict != null && !['convicted', 'acquitted', 'dismissed', 'open'].includes(d.verdict)) err(f, id, `defendants[${i}].verdict must be convicted|acquitted|dismissed|open`);
    for (const k of ['role', 'charge', 'reasoning', 'short']) t4(f, id, `defendants[${i}].${k}`, d[k]);
    const s = d.sanction;
    if (s) for (const k of ['dailyUnits', 'dailyAmount', 'fineCHF', 'probationYears']) if (s[k] != null && typeof s[k] !== 'number') err(f, id, `defendants[${i}].sanction.${k} must be a number or null (day-fines as count+rate)`);
  });
}
seen = new Set();
const today = new Date(process.env.VALIDATE_TODAY || Date.now());
for (const j of jobs) {
  const f = 'jobs.json', id = common(f, j, seen);
  for (const k of ['title', 'employer', 'url', 'datePosted']) if (!j[k]) err(f, id, `${k} missing`);
  if (!isUrl(j.url)) err(f, id, 'url invalid');
  enumOrNull(f, id, 'role', j.role, TAX.role);
  if (j.canton != null && !CANTONS.includes(j.canton)) err(f, id, `canton "${j.canton}" invalid`);
  if (isDate(j.datePosted) && (today - new Date(j.datePosted)) / 864e5 > JOB_MAX_AGE_DAYS) warn(f, id, `posted ${j.datePosted}, older than ${JOB_MAX_AGE_DAYS} days – remove`);
}
const jobUrls = jobs.map(j => j.url); if (new Set(jobUrls).size !== jobUrls.length) err('jobs.json', '-', 'duplicate job URL');

for (const w of warnings) console.warn('WARN  ' + w);
for (const e of errors) console.error('ERROR ' + e);
console.log(`validate-data: ${accidents.length} accidents, ${rulings.length} rulings, ${jobs.length} jobs – ${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);
