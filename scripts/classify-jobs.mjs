#!/usr/bin/env node
// LLM labelling of data/jobs-queue.json: genuine occupational-safety role in Switzerland?, canton, role type and
// recruiter-repost grouping (same job advertised by several agencies/boards under different titles -> same group).
// Labels are cached on each candidate as job.llm (keyed by url hash). Skips cleanly without OPENAI_API_KEY.
import fs from 'node:fs';
import { extract, flush, available, hash } from './lib/llm.mjs';

const F = new URL('../data/jobs-queue.json', import.meta.url);
if (!available()) { console.warn('classify:jobs: OPENAI_API_KEY missing – skipping.'); process.exit(0); }
if (!fs.existsSync(F)) process.exit(0);
const jobs = JSON.parse(fs.readFileSync(F));
const VERSION = 1;
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
    const out = await extract({ system: SYS, name: 'jobs', schema: SCHEMA, input: `Label only items n=0..${b.length - 1}; the rest are context for sameAs.\n${JSON.stringify(list)}` });
    // union-find over sameAs links so mutual/chained reposts share one group id
    const parent = ctx.map((j, n) => n), find = n => parent[n] === n ? n : (parent[n] = find(parent[n]));
    for (const l of out.items) if (l.sameAs != null && ctx[l.sameAs] && l.sameAs !== l.n) parent[find(l.n)] = find(l.sameAs);
    const groupOf = n => { const members = ctx.filter((_, m) => find(m) === find(n)); const old = members.find(j => j.llm?.group && !b.includes(j));
      return old ? old.llm.group : members.map(j => hash(j.url)).sort()[0]; };
    for (const l of out.items) {
      const j = b[l.n]; if (!j) continue;
      const other = l.sameAs != null && l.sameAs !== l.n ? ctx[l.sameAs] : null;
      j.llm = { v: VERSION, key: hash(j.url), at: new Date().toISOString(), keep: l.keep, confidence: l.confidence, role: l.role, canton: l.canton, reason: l.reason, group: groupOf(l.n), repostOf: other?.url || null };
    }
    fs.writeFileSync(F, JSON.stringify(jobs, null, 2));
  }
} catch (e) { stopped = e.message; console.warn('classify:jobs stopped:', e.message); }
flush({ jobs: todo.length, stopped });
const groups = new Set(jobs.filter(j => j.llm?.keep).map(j => j.llm.group));
console.log(`classify:jobs: ${jobs.filter(j => j.llm?.keep).length} kept in ${groups.size} groups, ${jobs.filter(j => j.llm && !j.llm.keep).length} rejected.`);
