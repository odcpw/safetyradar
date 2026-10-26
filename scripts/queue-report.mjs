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
