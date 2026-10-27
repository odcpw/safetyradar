#!/usr/bin/env node
// LLM labelling of data/jobs-queue.json: genuine occupational-safety role in Switzerland?, canton, role type and
// recruiter-repost grouping (same job advertised by several agencies/boards under different titles -> same group).
// Labels are cached on each candidate as job.llm (keyed by url hash). Skips cleanly without OPENAI_API_KEY.
import fs from 'node:fs';
import { extract, decide, flush, available, hash } from './lib/llm.mjs';

const F = new URL('../data/jobs-queue.json', import.meta.url);
if (!available()) { console.warn('classify:jobs: OPENAI_API_KEY missing – skipping.'); process.exit(0); }
if (!fs.existsSync(F)) process.exit(0);
const jobs = JSON.parse(fs.readFileSync(F));
const VERSION = 1;
const EFFORT = process.env.LLM_EFFORT_JOBS || 'low', VIA = process.env.LLM_FIELDS_VIA || 'responses';
const ROLES = { sifa: 'Sicherheitsfachkraft / safety specialist (EKAS)', hse: 'HSE / EHS / SHE specialist or manager', sibe: 'Sicherheitsbeauftragte(r) / safety officer', asgs: 'ASGS / MSST / Arbeitssicherheit und Gesundheitsschutz', fire: 'fire safety with workplace-safety duties', process_safety: 'process / plant safety', other: 'other occupational-safety role', reject: 'not an occupational-safety role' };
// LLM_FIELDS_VIA=decisions: keep/role/canton as Decisions questions; Responses only for reason + repost link.
async function viaDecisions(list, nLabel) {
  const qs = [];
  for (let n = 0; n < nLabel; n++) {
    qs.push({ type: 'predicate', name: `keep${n}`, instructions: `Job n=${n}: ${SYS.split('\n').slice(1, 3).join(' ')} Is job n=${n} such a role?` });
    qs.push({ type: 'choice', name: `role${n}`, instructions: `Job n=${n}: role category`, choices: Object.entries(ROLES).map(([value, description]) => ({ value, description })) });
    qs.push({ type: 'choice', name: `canton${n}`, instructions: `Job n=${n}: Swiss canton of the work location (unknown if unclear)`, choices: [...CANTONS, 'unknown'].map(value => ({ value })) });
  }
  const a = await decide({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'Job ads for a Swiss occupational-safety jobs board.' }, { type: 'input_json', data: list }] }], questions: qs });
  const free = await extract({ system: 'For each job n (only n < ' + nLabel + '): reason (max 12 words, English: is it an occupational-safety role?) and sameAs: n of another listed job that is very likely the same vacancy (reposted by a recruiter under another title), else null.',
    name: 'jobs', effort: EFFORT, input: JSON.stringify(list), schema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'reason', 'sameAs'],
      properties: { n: { type: 'integer' }, reason: { type: 'string' }, sameAs: { type: ['integer', 'null'] } } } } } } });
  const fr = new Map(free.items.map(i => [i.n, i]));
  return Array.from({ length: nLabel }, (_, n) => ({ n, keep: (a[`keep${n}`]?.probability ?? 0) >= 0.5, confidence: a[`keep${n}`]?.probability ?? 0,
    role: a[`role${n}`]?.choice ?? 'other', canton: a[`canton${n}`]?.choice === 'unknown' ? null : a[`canton${n}`]?.choice ?? null, reason: fr.get(n)?.reason ?? '', sameAs: fr.get(n)?.sameAs ?? null }));
}
const CANTONS = ['AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE','NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH'];
const SCHEMA = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: {
  type: 'object', additionalProperties: false, required: ['n', 'keep', 'confidence', 'role', 'canton', 'reason', 'sameAs'],
  properties: {
    n: { type: 'integer' }, keep: { type: 'boolean' }, confidence: { type: 'number' },
    role: { type: 'string', enum: ['sifa', 'hse', 'sibe', 'asgs', 'fire', 'process_safety', 'other', 'reject'] },
    canton: { anyOf: [{ type: 'string', enum: CANTONS }, { type: 'null' }] },
    reason: { type: 'string', description: 'max 12 words, English' },
    sameAs: { type: ['integer', 'null'], description: 'n of another listed job that is very likely the same position (same employer/location/role, e.g. reposted by a recruiter under a different title), else null' },
  } } } } };
const SYS = `You screen job ads for the Safety Radar jobs board (occupational health & safety jobs in Switzerland).
keep=true only if the main purpose of the role is occupational safety / health & safety at work in Switzerland: Sicherheitsfachkraft (SiFa), ASGS/MSST, HSE/EHS manager/specialist/engineer, Sicherheitsbeauftragter (SiBe), chargé(e) de sécurité, Arbeitssicherheit, Arbeitsschutz, process/plant safety, fire safety officer with workplace-safety duties.
keep=false: IT/cyber/information security, food safety/quality only, patient/drug safety (pharmacovigilance), product safety/regulatory, security guards/Objektschutz, apprenticeships/internships for school leavers, roles where safety is only a side duty (production manager, site manager, facility manager "incl. safety"), jobs outside Switzerland.
Canton: from the location (2-letter code), null if unclear. sameAs: detect the same vacancy posted several times (agencies often hide the employer and change the title).`;

const todo = jobs.filter(j => process.env.LLM_FORCE || !j.llm || j.llm.key !== hash(j.url) || j.llm.v !== VERSION);
console.log(`classify:jobs: ${todo.length} of ${jobs.length} candidates need labels.`);
let stopped = null;
try {
  for (let i = 0; i < todo.length; i += 60) {
    const b = todo.slice(i, i + 60);
    // Earlier-labelled jobs are listed too, so reposts across runs are grouped.
    const ctx = [...b, ...jobs.filter(j => j.llm && !b.includes(j)).slice(0, 80)];
    const list = ctx.map((j, n) => ({ n, title: j.title, employer: j.employer, location: j.location, source: j.source, posted: j.datePosted }));
    const out = VIA === 'decisions' ? { items: await viaDecisions(list, b.length) }
      : await extract({ system: SYS, name: 'jobs', schema: SCHEMA, effort: EFFORT, input: `Label only items n=0..${b.length - 1}; the rest are context for sameAs.\n${JSON.stringify(list)}` });
    // union-find over sameAs links so mutual/chained reposts share one group id
    const parent = ctx.map((j, n) => n), find = n => parent[n] === n ? n : (parent[n] = find(parent[n]));
    for (const l of out.items) if (l.sameAs != null && ctx[l.sameAs] && l.sameAs !== l.n) parent[find(l.n)] = find(l.sameAs);
    const groupOf = n => { const members = ctx.filter((_, m) => find(m) === find(n)); const old = members.find(j => j.llm?.group && !b.includes(j));
      return old ? old.llm.group : members.map(j => hash(j.url)).sort()[0]; };
    for (const l of out.items) {
      const j = b[l.n]; if (!j) continue;
      const other = l.sameAs != null && l.sameAs !== l.n ? ctx[l.sameAs] : null;
      j.llm = { v: VERSION, key: hash(j.url), at: new Date().toISOString(), keep: l.keep, confidence: l.confidence, role: l.role, canton: l.canton, reason: l.reason, group: groupOf(l.n), via: VIA, repostOf: other?.url || null };
    }
    fs.writeFileSync(F, JSON.stringify(jobs, null, 2));
  }
} catch (e) { stopped = e.message; console.warn('classify:jobs stopped:', e.message); }
flush({ jobs: todo.length, stopped });
const groups = new Set(jobs.filter(j => j.llm?.keep).map(j => j.llm.group));
console.log(`classify:jobs: ${jobs.filter(j => j.llm?.keep).length} kept in ${groups.size} groups, ${jobs.filter(j => j.llm && !j.llm.keep).length} rejected.`);
