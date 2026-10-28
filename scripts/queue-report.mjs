// Summarises data/queue.json: kept vs dropped, by reason and language; writes data/queue-report.md for the reviewer.
import fs from 'node:fs';
const q = JSON.parse(fs.readFileSync(new URL('../data/queue.json', import.meta.url)));
const by = (f) => q.reduce((m, x) => (m[f(x)] = (m[f(x)] || 0) + 1, m), {});
const drafts = q.filter(x => x.status === 'draft');
let md = `# Review queue – ${new Date().toISOString().slice(0, 10)}\n\nTotal ${q.length} · drafts ${drafts.length} · dropped ${q.filter(x => x.status === 'dropped').length}\n\n`;
md += '## Drafts to review\n\n' + drafts.map(d => `- [ ] ${d.date ?? '????'} · ${d.lang} · ${d.kind} · ${d.draft?.canton ?? '??'} · ${d.title} — ${d.url}`).join('\n') + '\n';
fs.writeFileSync(new URL('../data/queue-report.md', import.meta.url), md);
console.log('Status:', by(x => x.status)); console.log('Drafts by language:', by(x => x.status === 'draft' ? x.lang : '-'));
console.log('Drop reasons:', by(x => x.status === 'dropped' ? x.reason : '-'));

// --- LLM review list (data/review.md): only keep=true items, grouped by likely event, with dedupe hints and draft paths.
import { hash } from './lib/llm.mjs';
import { reviewed } from './lib/review-feedback.mjs';
const labelled = q.filter(x => x.llm);
if (labelled.length) {
  const D = new URL('../data/', import.meta.url);
  const pubUrls = new Set(['accidents.json', 'rulings.json'].flatMap(f => JSON.parse(fs.readFileSync(new URL(f, D))).flatMap(e => [e.source?.url, ...(e.extraSources || []).map(s => s.url)])));
  const keep = labelled.filter(x => x.llm.keep);
  const byKey = new Map(q.map(x => [hash(x.url), x]));
  const root = x => { const seen = new Set(); let cur = x; while (cur.llm?.dupOf?.startsWith('queue:') && !seen.has(cur)) { seen.add(cur); const nx = byKey.get(cur.llm.dupOf.slice(6)); if (!nx) break; cur = nx; } return cur.llm?.dupOf && !cur.llm.dupOf.startsWith('queue:') ? cur.llm.dupOf : 'q:' + hash(cur.url); };
  const groups = new Map();
  for (const x of keep) { const k = root(x); (groups.get(k) || groups.set(k, []).get(k)).push(x); }
  const pubIds = new Set(['accidents.json', 'rulings.json'].flatMap(f => JSON.parse(fs.readFileSync(new URL(f, D))).map(e => e.id)));
  // Stage-2 feedback (review-feedback.mjs): rejected groups disappear; published ones only list sources not yet handled.
  const isPub = ([k, xs]) => pubIds.has(k) || xs.some(x => pubUrls.has(x.url) || x.status === 'published');
  const allGroups = [...groups].filter(g => isPub(g) || !g[1].some(x => x.status === 'rejected'));
  const fresh = allGroups.filter(g => !isPub(g));
  const known = allGroups.filter(g => !fresh.includes(g));
  const line = x => `  - ${x.date ?? '????'} · ${x.lang} · ${x.sourceName || x.source} · conf ${(x.llm.confidence ?? 0).toFixed(2)} · ${x.title}\n    ${x.url}${x.draftPath ? `\n    draft: \`${x.draftPath}\`` : ''}${x.draftNote ? `\n    note: ${x.draftNote}` : ''}`;
  let r = `# LLM review list – ${new Date().toISOString().slice(0, 10)}\n\n${labelled.length} labelled · ${keep.length} kept · ${fresh.length} new events/cases · ${known.length} already published (new sources only)\n\n## New – review and publish\n\n`;
  for (const [, xs] of fresh.sort((a, b) => String(b[1][0].date).localeCompare(String(a[1][0].date)))) {
    const h = xs[0].llm;
    r += `- [ ] **${h.type}** · ${h.canton ?? '??'} · ${h.place ?? '?'} · ${h.outcome ?? '?'} · ${h.industry ?? '?'} — ${h.reason}\n${xs.map(line).join('\n')}\n`;
  }
  r += `\n## Already published – check for extra sources / updates\n\n`;
  for (const [k, all] of known) { const xs = all.filter(x => !reviewed(x)); if (xs.some(x => !pubUrls.has(x.url))) r += `- ${k}: ${xs.filter(x => !pubUrls.has(x.url)).length} unlinked source(s)\n${xs.filter(x => !pubUrls.has(x.url)).map(line).join('\n')}\n`; }
  const jq = new URL('jobs-queue.json', D);
  if (fs.existsSync(jq)) {
    const all = JSON.parse(fs.readFileSync(jq)), done = new Set(all.filter(reviewed).map(j => j.llm?.group).filter(Boolean));
    const jobs = all.filter(j => j.llm?.keep && !reviewed(j) && !done.has(j.llm.group));
    const jg = new Map(); for (const j of jobs) (jg.get(j.llm.group) || jg.set(j.llm.group, []).get(j.llm.group)).push(j);
    r += `\n## Jobs – ${jobs.length} kept in ${jg.size} groups\n\n` + [...jg.values()].map(js => `- [ ] ${js[0].llm.canton ?? '??'} · ${js[0].llm.role} · ${js.map(j => `${j.title} (${j.employer}, ${j.source}) ${j.url}`).join('\n    = ')}`).join('\n') + '\n';
  }
  fs.writeFileSync(new URL('review.md', D), r);
  console.log(`data/review.md: ${fresh.length} new groups, ${known.length} known.`);
}
