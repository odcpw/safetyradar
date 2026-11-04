// Helper for send-week.sh: schedules or starts the 4 drafts "safetyradar-<issue>-<lang>". Uses the same admin login
// as weekly-issue.mjs (credentials from /srv/listmonk/.env, never printed).
import fs from 'node:fs';
import { issueId } from '../../scripts/lib/utm.mjs';
const LM = process.env.LISTMONK_URL || 'http://127.0.0.1:9100';
const argv = process.argv.slice(2); const now = argv.includes('--now');
const issue = (argv.find(a => /^\d{4}-w\d{2}$/i.test(a)) || issueId()).toLowerCase();
const [wy, wn] = issue.split('-w').map(Number);
let cookie = '';
async function api(method, p, body) {
  const r = await fetch(LM + p, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${t.slice(0, 200)}`); return t ? JSON.parse(t).data : null;
}
const env = Object.fromEntries(fs.readFileSync(process.env.LISTMONK_ENV || '/srv/listmonk/.env', 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const jar = new Map(); const keep = r => (r.headers.getSetCookie?.() || []).forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); });
const r0 = await fetch(LM + '/admin/login'); keep(r0); const nonce = ((await r0.text()).match(/name="nonce" value="([^"]*)"/) || [])[1] || '';
const r1 = await fetch(LM + '/admin/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: env.LISTMONK_ADMIN_USER, password: env.LISTMONK_ADMIN_PASSWORD, nonce }), headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
keep(r1); cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
// Thursday 15:00 Europe/Zurich of the issue week
const jan4 = new Date(Date.UTC(wy, 0, 4)); const thu = new Date(jan4); thu.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (wn - 1) * 7 + 3);
const g = Date.UTC(thu.getUTCFullYear(), thu.getUTCMonth(), thu.getUTCDate(), 15, 0);
const off = new Date(new Date(g).toLocaleString('sv-SE', { timeZone: 'Europe/Zurich' }) + 'Z') - g;
const sendAt = new Date(g - off);
if (!now && sendAt < new Date()) throw new Error(`Thursday 15:00 of ${issue} is in the past – use --now`);
for (const lang of ['de', 'fr', 'it', 'en']) {
  const name = `safetyradar-${issue}-${lang}`;
  const c = (await api('GET', `/api/campaigns?per_page=50&query=${encodeURIComponent(name)}`)).results.find(x => x.name === name);
  if (!c) { console.log(`${name}: not found – skipped`); continue; }
  if (c.status !== 'draft') { console.log(`${name}: status ${c.status} – skipped`); continue; }
  if (now) await api('PUT', `/api/campaigns/${c.id}/status`, { status: 'running' });
  else {
    await api('PUT', `/api/campaigns/${c.id}`, { name: c.name, subject: c.subject, lists: c.lists.map(l => l.id), from_email: c.from_email, content_type: c.content_type, body: c.body, template_id: c.template_id, messenger: c.messenger, type: c.type, tags: c.tags, send_at: sendAt.toISOString() });
    await api('PUT', `/api/campaigns/${c.id}/status`, { status: 'scheduled' });
  }
  console.log(`${name} (#${c.id}): ${now ? 'sending now' : 'scheduled for ' + sendAt.toISOString()}`);
}
