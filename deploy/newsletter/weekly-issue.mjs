#!/usr/bin/env node
// Safety Radar weekly newsletter: builds one issue per language from the site's local data and saves them as
// Listmonk campaign DRAFTS (never sends or schedules). Idempotent: re-running in the same ISO week updates the
// week's drafts (matched by campaign name "safetyradar-<issue>-<lang>").
//   node deploy/newsletter/weekly-issue.mjs [--dry-run] [--preview=a@b.ch,...] [--week=2026-w45]
// "New" = ids present in data/*.json now but not in the last data commit authored before the previous Thursday
// 08:30 Europe/Zurich. Text comes from the published data (title + first sentence of the lesson); no LLM.
// Env: LISTMONK_URL (default http://127.0.0.1:9100), LISTMONK_ENV (default /srv/listmonk/.env, admin login),
//      APP_DIR (default /srv/safetyradar/app), OUT_DIR (default /srv/safetyradar/newsletter).
import { ledgerErrors, readLedger, reviewKey } from '../../scripts/lib/content-integrity.mjs';
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { tagUrl, issueId } from '../../scripts/lib/utm.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const APP = process.env.APP_DIR || '/srv/safetyradar/app';
const OUT = process.env.OUT_DIR || '/srv/safetyradar/newsletter';
const LM = process.env.LISTMONK_URL || 'http://127.0.0.1:9100';
const SITE = 'https://safetyradar.ch';
const LANGS = ['de', 'fr', 'it', 'en'];
const LIST_ID = { de: 3, fr: 4, it: 5, en: 6 };
const TEMPLATE_ID = 1; // default campaign template (no tracking pixel)
const MAX = { accidents: 6, rulings: 4, jobs: 5 };

const L = {
  week: { de: 'KW', fr: 'semaine', it: 'settimana', en: 'week' },
  intro: { de: 'Neu auf Safety Radar seit letztem Donnerstag.', fr: 'Nouveau sur Safety Radar depuis jeudi dernier.', it: 'Novità su Safety Radar da giovedì scorso.', en: 'New on Safety Radar since last Thursday.' },
  accidents: { de: 'Unfälle', fr: 'Accidents', it: 'Infortuni', en: 'Accidents' },
  rulings: { de: 'Urteile', fr: 'Jugements', it: 'Sentenze', en: 'Rulings' },
  jobs: { de: 'Neue Stellen', fr: 'Nouvelles offres', it: 'Nuove offerte', en: 'New jobs' },
  jobsCount: { de: n => `${n} neue Stellen in Arbeitssicherheit und HSE.`, fr: n => `${n} nouvelles offres en sécurité au travail et HSE.`, it: n => `${n} nuove offerte in sicurezza sul lavoro e HSE.`, en: n => `${n} new jobs in occupational safety and HSE.` },
  allJobs: { de: 'Alle Stellen', fr: 'Toutes les offres', it: 'Tutte le offerte', en: 'All jobs' },
  quiet: { de: 'Ruhige Woche: keine neuen Unfälle oder Urteile seit letztem Donnerstag.', fr: 'Semaine calme: aucun nouvel accident ni jugement depuis jeudi dernier.', it: 'Settimana tranquilla: nessun nuovo infortunio o sentenza da giovedì scorso.', en: 'Quiet week: no new accidents or rulings since last Thursday.' },
  quietSubj: { de: 'ruhige Woche', fr: 'semaine calme', it: 'settimana tranquilla', en: 'quiet week' },
  more: { de: 'Alles auf safetyradar.ch', fr: 'Tout sur safetyradar.ch', it: 'Tutto su safetyradar.ch', en: 'Everything on safetyradar.ch' },
};

// ---- week + window
const issue = String(args.week || issueId()).toLowerCase(); // 2026-w45
const [wy, wn] = issue.split('-w').map(Number);
function zurichTs(y, m, d, hh, mm) { // epoch seconds of a Europe/Zurich wall-clock time
  const guess = Date.UTC(y, m - 1, d, hh, mm) / 1000;
  const off = (new Date(new Date(guess * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Zurich' }) + 'Z') - guess * 1000) / 1000;
  return guess - off;
}
const jan4 = new Date(Date.UTC(wy, 0, 4));
const thu = new Date(jan4); thu.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (wn - 1) * 7 + 3); // Thursday of the issue week
const prevThu = new Date(thu); prevThu.setUTCDate(thu.getUTCDate() - 7);
const since = zurichTs(prevThu.getUTCFullYear(), prevThu.getUTCMonth() + 1, prevThu.getUTCDate(), 8, 30);

// ---- data: now vs. baseline commit
const git = (...a) => execFileSync('git', ['-c', `safe.directory=${APP}`, '-C', APP, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
const read = f => JSON.parse(fs.readFileSync(path.join(APP, 'data', f), 'utf8'));
const baseline = git('log', '--format=%H %at', '--', 'data/accidents.json', 'data/rulings.json', 'data/jobs.json')
  .trim().split('\n').map(l => l.split(' ')).find(([, at]) => +at < since)?.[0];
const old = f => { if (!baseline) return []; try { return JSON.parse(git('show', `${baseline}:data/${f}`)); } catch { return []; } };
const ledger = readLedger(APP);
const integrityErrors = ledgerErrors(APP, { accidents: read('accidents.json'), rulings: read('rulings.json') }, ledger);
if (integrityErrors.length) throw new Error(integrityErrors.join('\n'));
const fresh = f => { const before = new Set(old(f).map(x => x.id)); return read(f).filter(x => !before.has(x.id) && (f === 'jobs.json' || ledger[reviewKey(f.replace('.json',''), x.id)]?.state === 'verified')); };
const byDate = k => (a, b) => String(b[k] || '').localeCompare(String(a[k] || ''));
const relDate = x => x.published || x.firstSeen || null;
const sev = { fatal: 0, life_threatening: 1, serious: 2, injured: 3 };
// Date rules (Oliver: items must be recent by when they HAPPENED, not when the pipeline added them).
// An item must be new since the previous issue (not in the baseline data) AND pass its date rule; no valid date -> dropped.
//   accidents: source-confirmed event date (`accidentDate`; partial/unknown dates excluded) within [previous Thursday - 7 days grace, now]  (~14 days)
//   rulings:   by RELEASE, never by decision date: `published` (date the source shows: bger.ch "Neue Entscheide" day,
//              news article date), else the separate fallback `firstSeen` (day we first fetched it), within
//              [previous Thursday - 23 days grace, now] (~30 days). Neither -> dropped.
//   jobs:      `datePosted` within [previous Thursday, now] (jobs.json only holds live postings; expired ones are removed
//              by the pipeline). Without a posting date the item is dropped.
const ymd = ts => new Date(ts * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
const today = ymd(Date.now() / 1000);
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && String(d) <= today;
const inRange = (d, from) => validDate(d) && d >= from && d <= today;
const accFrom = ymd(since - 7 * 86400), rulFrom = ymd(since - 23 * 86400), jobFrom = ymd(since);
const dropped = [];
const keep = (list, kind, field, from) => list.filter(x => { const d = field(x); const ok = inRange(d, from); if (!ok) dropped.push({ kind, id: x.id, date: d ?? null }); return ok; });
const accidents = keep(fresh('accidents.json'), 'accident', x => x.accidentDate, accFrom)
  .sort((a, b) => (sev[a.outcome] ?? 9) - (sev[b.outcome] ?? 9) || byDate('date')(a, b));
const rulings = keep(fresh('rulings.json'), 'ruling', relDate, rulFrom).sort((a, b) => String(relDate(b)).localeCompare(String(relDate(a))));
const jobs = keep(fresh('jobs.json'), 'job', x => x.datePosted, jobFrom).sort(byDate('datePosted'));

// ---- rendering
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const firstSentence = s => { s = String(s || '').trim(); const m = s.match(/^.{20,220}?[.!?](\s|$)/); return (m ? m[0] : s.slice(0, 200)).trim(); };
const link = (p, content) => esc(tagUrl(SITE + p, { campaign: issue, content }));
const fmtDate = (d, lang) => { return String(d).split('-').reverse().join('.'); };
const pick = (o, lang) => (o && typeof o === 'object') ? (o[lang] || o.de || o.en || '') : (o || '');
const DL = { pub: { de: 'publiziert', fr: 'publié le', it: 'pubblicata il', en: 'published' }, seen: { de: 'erfasst', fr: 'repéré le', it: 'rilevata il', en: 'first seen' },
  dec: { de: 'Entscheid', fr: 'décision du', it: 'decisione del', en: 'decided' } };
const rulDates = (x, lang) => `${x.published ? DL.pub[lang] : DL.seen[lang]} ${fmtDate(relDate(x), lang)}`
  + (x.judgmentDate && x.judgmentDate !== relDate(x) ? ` · ${DL.dec[lang]} ${fmtDate(x.judgmentDate, lang)}` : '');
function item(x, kind, lang) {
  const title = pick(x.title, lang); const line = firstSentence(pick(x.lesson, lang));
  if (!title) return '';
  return `<p style="margin:0 0 14px"><a href="${link(`/${lang}/${kind}/${x.id}/`)}" style="font-weight:600">${esc(title)}</a>`
    + ` <span style="color:#888">· ${esc(kind === 'rulings' ? rulDates(x, lang) : fmtDate(x.accidentDate, lang))}${x.canton ? ` · ${esc(x.canton)}` : ''}</span><br/>${esc(line)}</p>`;
}
// Subject (Oliver): short factual counts, never an item title (no fatal/death wording, no names), zero counts skipped.
//   DE "Safety Radar KW 45: 4 Arbeitsunfälle, 18 neue Stellen"
const SUBJ = {
  accidents: { de: n => n === 1 ? '1 Arbeitsunfall' : `${n} Arbeitsunfälle`, fr: n => n === 1 ? '1 accident' : `${n} accidents`,
    it: n => n === 1 ? '1 infortunio' : `${n} infortuni`, en: n => n === 1 ? '1 workplace accident' : `${n} workplace accidents` },
  rulings: { de: n => n === 1 ? '1 Urteil' : `${n} Urteile`, fr: n => n === 1 ? '1 jugement' : `${n} jugements`, it: n => n === 1 ? '1 sentenza' : `${n} sentenze`, en: n => n === 1 ? '1 ruling' : `${n} rulings` },
  jobs: { de: n => n === 1 ? '1 neue Stelle' : `${n} neue Stellen`, fr: n => n === 1 ? '1 offre d’emploi' : `${n} offres d’emploi`,
    it: n => n === 1 ? '1 nuova offerta' : `${n} nuove offerte`, en: n => n === 1 ? '1 new job' : `${n} new jobs` },
};
function subjectFor(lang) {
  const parts = [['accidents', accidents.length], ['rulings', rulings.length], ['jobs', jobs.length]].filter(([, n]) => n > 0).map(([k, n]) => SUBJ[k][lang](n));
  const colon = lang === 'fr' ? ' : ' : ': ';
  return `Safety Radar ${L.week[lang]} ${wn}${colon}${parts.length ? parts.join(', ') : L.quietSubj[lang]}`;
}
function build(lang) {
  const a = accidents.slice(0, MAX.accidents), r = rulings.slice(0, MAX.rulings), j = jobs.slice(0, MAX.jobs);
  const quiet = !accidents.length && !rulings.length;
  const subject = subjectFor(lang);
  let h = `<h2 style="margin-top:0">Safety Radar – ${L.week[lang]} ${wn}</h2><p>${L.intro[lang]}</p>`;
  if (quiet) h += `<p>${L.quiet[lang]}</p>`;
  if (r.length) h += `<h3>${L.rulings[lang]} (${rulings.length})</h3>` + r.map(x => item(x, 'rulings', lang)).join('');
  if (a.length) h += `<h3>${L.accidents[lang]} (${accidents.length})</h3>` + a.map(x => item(x, 'accidents', lang)).join('');
  if (jobs.length) {
    h += `<h3>${L.jobs[lang]}</h3><p>${L.jobsCount[lang](jobs.length)}</p><ul>`
      + j.map(x => `<li>${esc(x.title)} · ${esc(x.employer)}${x.location ? `, ${esc(x.location)}` : ''}</li>`).join('')
      + `</ul><p><a href="${link(`/${lang}/jobs/`)}">${L.allJobs[lang]} →</a></p>`;
  }
  h += `<p style="margin-top:24px"><a href="${link(`/${lang}/`)}">${L.more[lang]}</a></p>`;
  return { lang, subject, body: h, counts: { accidents: accidents.length, rulings: rulings.length, jobs: jobs.length, shown: a.length + r.length + j.length }, quiet };
}
const issues = LANGS.map(build);

// ---- Listmonk (admin session; credentials read from LISTMONK_ENV, never printed)
let cookie = '';
async function api(method, p, body) {
  const r = await fetch(LM + p, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t).data : null;
}
async function login() {
  const env = Object.fromEntries(fs.readFileSync(process.env.LISTMONK_ENV || '/srv/listmonk/.env', 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const r0 = await fetch(LM + '/admin/login'); const html = await r0.text();
  const jar = new Map(); const keep = r => (r.headers.getSetCookie?.() || []).forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); });
  keep(r0);
  const nonce = (html.match(/name="nonce" value="([^"]*)"/) || [])[1] || '';
  const form = new URLSearchParams({ username: env.LISTMONK_ADMIN_USER, password: env.LISTMONK_ADMIN_PASSWORD, nonce });
  const r1 = await fetch(LM + '/admin/login', { method: 'POST', body: form, redirect: 'manual', headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  keep(r1); cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (r1.status >= 400) throw new Error(`listmonk login failed: HTTP ${r1.status}`);
}

const summary = { issue, rules: { accidentsFrom: accFrom, rulingsFrom: rulFrom, jobsFrom: jobFrom, to: today }, dropped, since: new Date(since * 1000).toISOString(), baseline, generatedAt: new Date().toISOString(), campaigns: [] };
if (args['dry-run']) {
  for (const i of issues) { console.log(`[dry-run] ${i.lang}: ${i.subject} ${JSON.stringify(i.counts)}`); }
  console.log('dropped:', JSON.stringify(dropped));
  if (args.html) fs.writeFileSync(args.html, issues.map(i => `<h1>${i.lang}</h1>${i.body}`).join('<hr/>'));
  process.exit(0);
}
await login();
const settings = await api('GET', '/api/settings');
const from = settings['app.from_email'];
for (const i of issues) {
  const name = `safetyradar-${issue}-${i.lang}`;
  const found = (await api('GET', `/api/campaigns?per_page=50&query=${encodeURIComponent(name)}`)).results.filter(c => c.name === name);
  const payload = { name, subject: i.subject, lists: [LIST_ID[i.lang]], from_email: from, content_type: 'html', body: i.body, template_id: TEMPLATE_ID, type: 'regular', messenger: 'email', tags: ['safetyradar', issue, i.lang], archive: false };
  let c;
  if (found.length) {
    if (found[0].status !== 'draft') { console.log(`${name}: status ${found[0].status} – left unchanged`); summary.campaigns.push({ lang: i.lang, id: found[0].id, name, subject: found[0].subject, status: found[0].status, unchanged: true }); continue; }
    c = await api('PUT', `/api/campaigns/${found[0].id}`, payload);
  } else c = await api('POST', '/api/campaigns', payload);
  summary.campaigns.push({ lang: i.lang, id: c.id, name, subject: i.subject, status: c.status, counts: i.counts, quiet: i.quiet });
  console.log(`${name}: draft ${c.id} – ${i.subject} ${JSON.stringify(i.counts)}`);
}
// Preview: Listmonk test-send of the DE and EN drafts. Recipients must exist as Listmonk subscribers
// (created without any list if missing, so they never receive real campaigns).
const preview = args.preview === true ? 'oliver@decaro.ch' : args.preview;
if (preview) {
  const to = String(preview).split(',').map(s => s.trim()).filter(Boolean);
  for (const email of to) {
    const q = await api('GET', `/api/subscribers?per_page=5&query=${encodeURIComponent(`subscribers.email='${email.replace(/'/g, "''")}'`)}`);
    if (!q.results.length) await api('POST', '/api/subscribers', { email, name: email.split('@')[0], status: 'enabled', lists: [], preconfirm_subscriptions: true });
  }
  for (const c of summary.campaigns.filter(c => ['de', 'en'].includes(c.lang))) {
    const full = await api('GET', `/api/campaigns/${c.id}`);
    await api('POST', `/api/campaigns/${c.id}/test`, { ...full, lists: full.lists.map(l => l.id), template_id: TEMPLATE_ID, subscribers: to });
    c.preview = to; console.log(`preview ${c.name} -> ${to.length} recipient(s)`);
  }
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${issue}.json`), JSON.stringify(summary, null, 2) + '\n');
console.log(`summary -> ${path.join(OUT, issue + '.json')}`);
