#!/usr/bin/env node
// Safety Radar – daily job crawler. Pulls Swiss EHS / occupational-safety vacancies from robots.txt-permitted
// public endpoints (see docs/source-audit.md), keyword-filters, normalizes, dedupes against data/jobs.json and
// the existing queue, drops expired/old postings and writes candidates to data/jobs-queue.json (gitignored).
// Never publishes into jobs.json – a human reviews. Stores metadata + link only, no ad text. Node >= 20, no deps.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUEUE = path.join(ROOT, 'data', 'jobs-queue.json');
const SUMMARY = path.join(ROOT, 'data', 'jobs-queue-summary.md');
const JOBS = path.join(ROOT, 'data', 'jobs.json');
const UA = 'SafetyRadarBot/0.2 (+https://safetyradar.ch)';
const MAX_AGE_DAYS = 60;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Search terms per site. Platform search is fuzzy/semantic, so every hit is re-filtered by SAFETY below.
const JC_TERMS = { de: ['Arbeitssicherheit', 'Sicherheitsfachkraft', 'Sicherheitsfachmann', 'ASGS', 'Sicherheitsbeauftragter', 'HSE Manager', 'EHS'],
  fr: ['sécurité au travail', 'chargé de sécurité', 'santé et sécurité au travail', 'HSE'], en: ['Health and Safety', 'EHS Manager'], it: ['sicurezza sul lavoro'] };
const SOURCES = [
  ...Object.entries(JC_TERMS).flatMap(([lang, terms]) => terms.map(t => ({ id: 'jobs.ch', type: 'jobcloud', lang,
    url: `https://www.jobs.ch/${lang === 'fr' ? 'fr/offres-emplois' : lang === 'en' ? 'en/vacancies' : 'de/stellenangebote'}/?term=${encodeURIComponent(t)}`,
    detail: id => `https://www.jobs.ch/${lang === 'fr' ? 'fr/offres-emplois' : lang === 'en' ? 'en/vacancies' : 'de/stellenangebote'}/detail/${id}/` }))),
  ...['sécurité au travail', 'chargé de sécurité', 'HSE', 'MSST', 'santé sécurité'].map(t => ({ id: 'jobup.ch', type: 'jobcloud', lang: 'fr',
    url: `https://www.jobup.ch/fr/emplois/?term=${encodeURIComponent(t)}`, detail: id => `https://www.jobup.ch/fr/emplois/detail/${id}/` })),
  ...['arbeitssicherheit', 'sicherheitsfachmann', 'sicherheitsbeauftragter', 'hse', 'ehs', 'asgs'].map(t => ({ id: 'jobscout24.ch', type: 'jobscout24', lang: 'de',
    url: `https://www.jobscout24.ch/de/jobs/${t}/` })),
  ...['HSE', 'EHS', 'Safety', 'Sicherheit'].flatMap(t => [
    { id: 'Novartis (Workday)', type: 'workday', lang: 'en', employer: 'Novartis', url: 'https://novartis.wd3.myworkdayjobs.com/wday/cxs/novartis/Novartis_Careers/jobs', site: 'https://novartis.wd3.myworkdayjobs.com/Novartis_Careers', q: `${t} Switzerland` },
    { id: 'Alcon (Workday)', type: 'workday', lang: 'en', employer: 'Alcon', url: 'https://alcon.wd5.myworkdayjobs.com/wday/cxs/alcon/careers_alcon/jobs', site: 'https://alcon.wd5.myworkdayjobs.com/careers_alcon', q: `${t} Switzerland` },
  ]),
];

// Safety-role filter (titles only). Accent-folded, lower-case.
const SAFETY = /arbeitssicherheit|arbeits- ?und gesundheitsschutz|gesundheitsschutz|sicherheitsfach|sifa\b|sibe\b|sicherheitsbeauftragt|sicherheitsingenieur|sicherheitsexpert|\basgs\b|\bkopas\b|\bmsst\b|\basa\b|\bhse\b|\behs\b|\bshe\b|\bsheq\b|\bhseq\b|\bqhse\b|\behsq\b|health (and|&) safety|safety (manager|officer|specialist|engineer|expert|advisor|coordinator|lead)|occupational (health|safety)|workplace safety|securite au travail|sante et securite|sante-securite|charge\.?e? de securite|specialiste (en )?securite|ingenieur (de |en )?securite|conseill.{0,3} en securite|sicurezza sul lavoro|responsabile (della )?sicurezza|addett.{1} alla sicurezza|specialista (della )?sicurezza|tecnico (della )?sicurezza|brandschutz|protection incendie/;
const EXCLUDE = /\b(it|cyber|informations?|information|data|food|lebensmittel|product|produkt|patient|drug|arzneimittel|pharmacovigilance|software|security analyst|soc)\b.{0,15}(security|safety|sicherheit|securite)|(security|safety|sicherheit|securite).{0,6}\b(it|cyber|informatique|software)\b|cybersecurity|informatiksicherheit|lebensmittelsicherheit|food safety|patient safety|drug safety|pharmacovigilance|securite informatique|securite alimentaire|lehrstelle|lernende|apprenti/;
const fold = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const isSafety = t => SAFETY.test(fold(t)) && !EXCLUDE.test(fold(t));
const roleOf = t => { const f = fold(t);
  return /brandschutz|incendie/.test(f) && !/arbeitssicherheit|securite au travail/.test(f) ? 'fire' : /\basgs\b|arbeitssicherheit und gesundheitsschutz|securite au travail et (protection|sante)/.test(f) ? 'asgs'
    : /\b(hse|ehs|she|sheq|hseq|qhse|ehsq)\b|health (and|&) safety/.test(f) ? 'hse' : /sicherheitsfach|sifa|sicherheitsingenieur|ingenieur (de |en )?securite|specialiste/.test(f) ? 'sifa' : 'safety'; };
const guessLang = (t, dflt) => { const f = fold(t);
  return /sicherheit|beauftragt|fachspezialist|fachperson|\b(und|fur|mit|leiter)\b|\(m\/w|\(w\/m/.test(f) ? 'de' : /\b(de|du|et|au|la|le|des|charge|securite)\b|\(h\/f|\(f\/h/.test(f) ? 'fr'
    : /\b(sicurezza|della|responsabile|addetto)\b/.test(f) ? 'it' : /\b(manager|specialist|engineer|officer|safety|health)\b/.test(f) ? 'en' : dflt; };
const CANTONS = 'ZH BE LU UR SZ OW NW GL ZG FR SO BS BL SH AR AI SG GR AG TG TI VD VS NE GE JU'.split(' ');
const CITY_CANTON = { zurich: 'ZH', winterthur: 'ZH', basel: 'BS', bern: 'BE', berne: 'BE', geneve: 'GE', geneva: 'GE', lausanne: 'VD', luzern: 'LU', lucerne: 'LU', 'st. gallen': 'SG', lugano: 'TI', bellinzona: 'TI', chur: 'GR', aarau: 'AG', zug: 'ZG', fribourg: 'FR', neuchatel: 'NE', sion: 'VS', schaffhausen: 'SH', solothurn: 'SO', frauenfeld: 'TG', stein: 'AG', muttenz: 'BL', 'schweizerhalle': 'BL', 'rotkreuz': 'ZG', 'fribourg': 'FR', 'monthey': 'VS', 'visp': 'VS', 'kaiseraugst': 'AG' };
const cantonOf = loc => { const m = (loc || '').match(/\b([A-Z]{2})\b/g); const c = m?.find(x => CANTONS.includes(x)); if (c) return c;
  const f = fold(loc); for (const [k, v] of Object.entries(CITY_CANTON)) if (f.includes(k)) return v; return null; };

// --- robots.txt (RFC 9309 longest match; same logic as fetch-sources.mjs)
const robotsCache = new Map();
async function allowedByRobots(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    const rules = [];
    try {
      const r = await fetch(u.origin + '/robots.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (r.ok) { let applies = false, lastWasUA = false;
        for (const raw of (await r.text()).split('\n')) {
          const line = raw.split('#')[0].trim(); if (!line) continue;
          const i = line.indexOf(':'); const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
          if (k === 'user-agent') { applies = (lastWasUA && applies) || v === '*' || /safetyradar/i.test(v); lastWasUA = true; continue; }
          lastWasUA = false;
          if (applies && (k === 'allow' || k === 'disallow') && v) rules.push({ allow: k === 'allow', path: v });
        } }
    } catch { /* unreachable robots => treat as allowed */ }
    robotsCache.set(u.origin, rules);
  }
  const p = u.pathname + u.search; let best = null;
  for (const rule of robotsCache.get(u.origin)) {
    const re = new RegExp('^' + rule.path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(p) && (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow))) best = rule;
  }
  return !best || best.allow;
}
const decode = s => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/\s+/g, ' ').trim();
const day = d => { const x = d ? new Date(d) : null; return x && !isNaN(x) ? x.toISOString().slice(0, 10) : null; };
const ago = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

async function runSource(s) {
  if (!(await allowedByRobots(s.url))) return { items: [], note: 'skipped: robots.txt disallows' };
  if (s.type === 'workday') {
    const r = await fetch(s.url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ limit: 20, offset: 0, searchText: s.q, appliedFacets: {} }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return { items: (j.jobPostings || []).map(p => { const m = (p.postedOn || '').match(/(\d+)\+? Days?/i);
      return { title: p.title, employer: s.employer, location: p.locationsText, url: s.site + p.externalPath,
        datePosted: /today/i.test(p.postedOn) ? ago(0) : /yesterday/i.test(p.postedOn) ? ago(1) : m ? ago(+m[1]) : null, approxDate: true }; }) };
  }
  const r = await fetch(s.url, { headers: { 'User-Agent': UA, 'Accept-Language': s.lang }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();
  if (s.type === 'jobcloud') { // jobs.ch / jobup.ch (JobCloud): the public search page embeds its result list as JSON in window.__INIT__
    const a = html.indexOf('__INIT__'); if (a < 0) throw new Error('no __INIT__ (layout changed?)');
    const start = html.indexOf('{', a); let depth = 0, inStr = false, end = start;
    for (; end < html.length; end++) { const ch = html[end];
      if (inStr) { if (ch === '\\') end++; else if (ch === '"') inStr = false; }
      else if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) break; }
    const j = JSON.parse(html.slice(start, end + 1));
    return { items: (j.vacancy?.results?.main?.results || []).map(v => ({ title: v.title, employer: v.company?.name, location: v.place,
      canton: v.locations?.[0]?.cantonCode || null, url: s.detail(v.id), datePosted: day(v.initialPublicationDate || v.publicationDate), active: v.isActive !== false })) };
  }
  if (s.type === 'jobscout24') {
    return { items: [...html.matchAll(/<li class="job-list-item[\s\S]*?<\/li>\s*(?=<li class="job-list-item|<\/ul>\s*<\/div>|$)/g)].map(([li]) => {
      const href = (li.match(/data-job-detail-url="([^"]+)"/) || [])[1]; const title = decode((li.match(/class="job-link-detail job-title"[^>]*title="([^"]*)"/) || [])[1]);
      const spans = [...((li.match(/<p class="job-attributes">([\s\S]*?)<\/p>/) || [])[1] || '').matchAll(/<span>([\s\S]*?)<\/span>/g)].map(m => decode(m[1]));
      const rel = decode((li.match(/<p class="job-date">([\s\S]*?)<\/p>/) || [])[1]); const n = parseInt(rel) || 0;
      const dd = /M/.test(rel) ? n * 30 : /W/.test(rel) ? n * 7 : /T|D/.test(rel) ? n : /h|Std/i.test(rel) ? 0 : null;
      return href && title ? { title, employer: spans[0], location: spans.slice(1).join(', '), url: new URL(href, s.url).toString(), datePosted: dd == null ? null : ago(dd), approxDate: true } : null;
    }).filter(Boolean) };
  }
  throw new Error('unknown type ' + s.type);
}

const norm = u => { try { const x = new URL(u); x.hash = ''; x.search = ''; return x.toString().replace(/\/$/, ''); } catch { return u; } };
const jobKey = (t, e) => fold(t).replace(/\(.*?\)|\d+\s*-?\s*\d*\s*%|[^a-z]+/g, ' ').trim() + '|' + fold(e).split(/[^a-z]+/).filter(w => w.length > 2)[0];

async function main() {
  const published = JSON.parse(await fs.readFile(JOBS, 'utf8'));
  const old = JSON.parse(await fs.readFile(QUEUE, 'utf8').catch(() => '[]'));
  const cutoff = ago(MAX_AGE_DAYS);
  const pubUrls = new Set(published.map(j => norm(j.url))), pubKeys = new Set(published.map(j => jobKey(j.title, j.employer)));
  const queue = [], urls = new Set(), keys = new Map(), report = {};
  // keep earlier, still-fresh candidates (and their review status) so the queue is stable day to day
  for (const q of old) if ((!q.datePosted || q.datePosted >= cutoff) && !pubUrls.has(norm(q.url)) && !pubKeys.has(jobKey(q.title, q.employer))) {
    queue.push(q); urls.add(norm(q.url)); keys.set(jobKey(q.title, q.employer), q); }
  const now = new Date().toISOString();
  for (const s of SOURCES) {
    const row = report[s.id] ??= { requests: 0, fetched: 0, safety: 0, new: 0, alsoAt: 0, published: 0, expired: 0, note: '' };
    row.requests++;
    try {
      const { items, note } = await runSource(s); if (note) row.note = note; row.fetched += items.length;
      for (const i of items) {
        if (!isSafety(i.title)) continue; row.safety++;
        const url = norm(i.url), key = jobKey(i.title, i.employer);
        if (pubUrls.has(url) || pubKeys.has(key)) { row.published++; continue; }
        if (i.active === false || (i.datePosted && i.datePosted < cutoff)) { row.expired++; continue; }
        if (urls.has(url)) continue;
        const twin = keys.get(key);
        if (twin) { urls.add(url); if (!(twin.alsoAt ||= []).some(a => a.url === url)) { twin.alsoAt.push({ source: s.id, url }); row.alsoAt++; } continue; }
        const c = { title: i.title, employer: i.employer || null, location: i.location || null, canton: i.canton || cantonOf(i.location),
          role: roleOf(i.title), lang: guessLang(i.title, s.lang), datePosted: i.datePosted || null, approxDate: !!i.approxDate,
          url, source: s.id, status: 'new', firstSeen: now };
        queue.push(c); urls.add(url); keys.set(key, c); row.new++;
      }
    } catch (e) { row.note = 'ERROR ' + (e.cause?.code || e.message); }
    await sleep(800); // be polite: ~1 request/second
  }
  queue.sort((a, b) => (b.datePosted || '').localeCompare(a.datePosted || ''));
  await fs.writeFile(QUEUE, JSON.stringify(queue, null, 2) + '\n');
  const bySource = {}; for (const q of queue) bySource[q.source] = (bySource[q.source] || 0) + 1;
  const md = [`# Jobs queue – ${now.slice(0, 16).replace('T', ' ')} UTC`, '', `${queue.length} candidates (posted ≤ ${MAX_AGE_DAYS} days, not in jobs.json). Review and copy wanted ones into data/jobs.json by hand.`, '',
    '| source | requests | fetched | safety hits | new | dupes merged | already published | expired/old | note |', '|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(report).map(([k, r]) => `| ${k} | ${r.requests} | ${r.fetched} | ${r.safety} | ${r.new} | ${r.alsoAt} | ${r.published} | ${r.expired} | ${r.note} |`), '',
    '| posted | title | employer | place | role | lang | source |', '|---|---|---|---|---|---|---|',
    ...queue.map(q => `| ${q.datePosted || '?'}${q.approxDate ? '~' : ''} | [${q.title.replace(/\|/g, '/')}](${q.url}) | ${q.employer || ''} | ${q.location || ''}${q.canton ? ' (' + q.canton + ')' : ''} | ${q.role} | ${q.lang} | ${q.source}${q.alsoAt ? ' +' + q.alsoAt.length : ''} |`)].join('\n');
  await fs.writeFile(SUMMARY, md + '\n');
  console.table(report);
  console.log('Queue by source:', bySource);
  console.log(`data/jobs-queue.json: ${queue.length} candidates · summary: data/jobs-queue-summary.md`);
}
main();
