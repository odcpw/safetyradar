// Re-applies relevance rules to the existing queue (after rule changes) without refetching.
import fs from 'node:fs';
import { classify } from './relevance.mjs';
const f = new URL('../data/queue.json', import.meta.url);
const q = JSON.parse(fs.readFileSync(f));
const pub = JSON.parse(fs.readFileSync(new URL('../data/accidents.json', import.meta.url)));
const same = (c, d) => c && d && pub.some(a => a.canton === c && Math.abs(new Date(a.date) - new Date(d)) <= 2 * 864e5);
for (const x of q) {
  if (x.status === 'published' || x.status === 'rejected') continue;
  const c = classify({ title: x.title, url: x.url, lang: x.lang, kind: x.kind, sourceCanton: x.draft?.canton, trusted: x.source === 'polizeinews-arbeitsunfaelle', sourceType: x.source === 'entscheidsuche' ? 'entscheidsuche' : 'rss' });
  if (c.keep && c.kind === 'accident' && same(c.canton, x.date)) { c.keep = false; c.reason = 'probably already published (same canton ±2 days)'; }
  x.status = c.keep ? 'draft' : 'dropped'; x.reason = c.reason;
  x.draft = c.keep ? { ...(x.draft || {}), canton: x.draft?.canton ?? c.canton, industry: c.industry, hazard: c.hazard, outcome: c.outcome, title: null, facts: null, lesson: null, needs: ['verify facts from source', 'write facts + lesson in DE/FR/IT/EN'] } : undefined;
}
fs.writeFileSync(f, JSON.stringify(q, null, 2));
