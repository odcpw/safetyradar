#!/usr/bin/env node
// Weekly page-view count from the IP-free Caddy log (deploy/caddy/access-log.snippet).
// Writes <OUT>/YYYY-Www.json and .txt for the previous ISO week (or the week given as arg, e.g. 2026-W45).
// Counts GET 200/304 HTML page views on safetyradar.ch, excluding bot-flagged requests and assets.
// Newsletter views: utm_source=newsletter, broken down by utm_campaign and utm_content (a/b).
import {campaignFromParams} from '../../public/measurement-core.mjs';
import {knownPages} from '../analytics/server.mjs';
import {writeReport} from '../analytics/report.mjs';
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib';
const LOG_DIR = process.env.LOG_DIR || '/var/log/caddy';
const OUT = process.env.OUT_DIR || '/srv/safetyradar/stats';
const BOT_RE = /bot|crawl|spider|slurp/i;
const ASSET_RE = /^\/(_astro|public)\/|\.(css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|xml|txt|json|pdf)$/i;

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dow);
  const y = t.getUTCFullYear(); const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return { y, w, id: `${y}-W${String(w).padStart(2, '0')}` };
}
function weekRange(y, w) { // Monday 00:00 Europe/Zurich approximated via UTC date + local offset at that time
  const jan4 = new Date(Date.UTC(y, 0, 4)); const mon = new Date(jan4); mon.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (w - 1) * 7);
  const zurich = (d) => { const s = d.toLocaleString('sv-SE', { timeZone: 'Europe/Zurich' }); return (new Date(s + 'Z') - d) / 1000; };
  const next = new Date(mon.getTime()+7*86400e3); const start = mon.getTime() / 1000 - zurich(mon); const end = next.getTime()/1000-zurich(next);
  return [start, end];
}
let y, w, id;
if (process.argv[2]) { const m = /^(\d{4})-W(\d{2})$/i.exec(process.argv[2]); if (!m) throw new Error('week must look like 2026-W45'); y = +m[1]; w = +m[2]; id = `${y}-W${m[2]}`; }
else { const d = new Date(Date.now() - 7 * 86400e3); ({ y, w, id } = isoWeek(new Date(d.toLocaleString('sv-SE', { timeZone: 'Europe/Zurich' }).slice(0, 10) + 'T12:00:00Z'))); }
const [start, end] = weekRange(y, w);

// Closed legacy logs are no longer rotated by the new Caddy writer. Keep their original 56-day policy.
if(fs.existsSync(LOG_DIR))for(const f of fs.readdirSync(LOG_DIR).filter(f=>/^safetyradar-access.*\.log(?:\.gz)?$/.test(f))){const p=path.join(LOG_DIR,f);if(fs.statSync(p).mtimeMs<Date.now()-56*86400e3)fs.unlinkSync(p);}
if(fs.existsSync(OUT))for(const f of fs.readdirSync(OUT).filter(f=>/^\d{4}-W\d{2}\.(json|txt)$/.test(f))){const p=path.join(OUT,f);if(fs.statSync(p).mtimeMs<Date.now()-56*86400e3)fs.unlinkSync(p);}
const files = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).filter(f => /^safetyradar-(access|pages)/.test(f)) : [];
const allowedPages=knownPages();
let total = 0, bots = 0; const pages = new Map(), nl = new Map();
const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
for (const f of files) {
  let buf = fs.readFileSync(path.join(LOG_DIR, f)); if (f.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue; let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.ts < start || e.ts >= end) continue;
    const r = e.request || {};
    if (r.method !== 'GET' || ![200, 304].includes(e.status) || !/^(www\.)?safetyradar\.ch$/.test(r.host || '')) continue;
    if(Object.hasOwn(e,'page') && !e.page)continue;
    const u = new URL(e.page || r.uri || '/', 'https://safetyradar.ch');
    if (ASSET_RE.test(u.pathname)||!Object.hasOwn(e,'page')&&!allowedPages.has(u.pathname)) continue;
    if (e.bot === 1 || e.bot === '1' || BOT_RE.test(String(e.bot || ''))) { bots++; continue; }
    total++; inc(pages, u.pathname);
    const q = u.searchParams;
    const cohort=e.cohort || campaignFromParams(q);
    if (cohort.source === 'newsletter') inc(nl, `${cohort.campaign}\t${cohort.variant}`);
  }
}
const top = [...pages].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([page, views]) => ({ page, views }));
const newsletter = [...nl].sort().map(([k, views]) => { const [campaign, content] = k.split('\t'); return { campaign, content, views }; });
const nlTotal = newsletter.reduce((s, x) => s + x.views, 0);
const res = { week: id, from: new Date(start * 1000).toISOString(), to: new Date(end * 1000).toISOString(), pageViews: total, botRequestsExcluded: bots, topPages: top, newsletter: { total: nlTotal, byCampaignAndContent: newsletter } };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(res, null, 2) + '\n');
const txt = [`Safety Radar – week ${id}`, `Page views (no bots, no assets): ${total}`, `Bot requests excluded: ${bots}`, '', 'Top pages:',
  ...top.map(x => `  ${String(x.views).padStart(6)}  ${x.page}`), '', `Legacy tagged newsletter page requests (not unique clicks): ${nlTotal}`,
  ...newsletter.map(x => `  ${String(x.views).padStart(6)}  ${x.campaign}  content=${x.content}`), ''].join('\n');
fs.writeFileSync(path.join(OUT, `${id}.txt`), txt);
console.log(`weekly-stats: ${id} ${total} views, ${nlTotal} from newsletter -> ${OUT}`);

writeReport(path.join(OUT,'events'),OUT);
