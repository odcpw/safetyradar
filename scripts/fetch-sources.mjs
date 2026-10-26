#!/usr/bin/env node
// Safety Radar – fetch candidate items from DE/FR/IT/EN sources into data/queue.json.
// Stores only title, link, date, source, language and machine guesses (canton/hazard/industry) – never article text.
// Node >= 20, no dependencies. Respects robots.txt (RFC 9309 longest-match).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './relevance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUEUE = path.join(ROOT, 'data', 'queue.json');
const PUBLISHED = ['accidents.json', 'rulings.json', 'jobs.json'].map(f => path.join(ROOT, 'data', f));
const UA = 'SafetyRadarBot/0.2 (+https://safetyradar.ch)';

const bing = (q, lang) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=${lang}-CH&cc=CH`;
const gn = (q, lang) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${lang}-CH&gl=CH&ceid=CH:${lang}`;
const NEWS_QUERIES = [
  // [query, lang, kind]
  ['Arbeitsunfall', 'de', 'accident'], ['Arbeitsunfall verurteilt', 'de', 'ruling'], ['Strafbefehl Arbeitsunfall', 'de', 'ruling'], ['Bundesgericht Arbeitsunfall', 'de', 'ruling'], ['Baustellenunfall', 'de', 'accident'],
  ['"accident de travail" Suisse', 'fr', 'accident'], ['accident de chantier ouvrier', 'fr', 'accident'], ['accident de travail condamné', 'fr', 'ruling'], ['homicide par négligence chantier', 'fr', 'ruling'], ['Tribunal fédéral accident de travail', 'fr', 'ruling'],
  ['infortunio sul lavoro', 'it', 'accident'], ['infortunio cantiere Ticino', 'it', 'accident'], ['infortunio sul lavoro condannato', 'it', 'ruling'], ['omicidio colposo cantiere Ticino', 'it', 'ruling'],
  ['workplace accident Switzerland', 'en', 'accident'],
];

export const SOURCES = [
  // --- German-language police / aggregators
  { id: 'polizeinews-arbeitsunfaelle', lang: 'de', type: 'rss', kind: 'accident', url: 'https://www.polizeinews.ch/arbeitsunfaelle/feed/', trusted: true },
  { id: 'police-be-blog', lang: 'de', type: 'rss', kind: 'accident', canton: 'BE', url: 'https://www.blog.police.be.ch/feed/' },
  { id: 'police-tg', lang: 'de', type: 'rss', kind: 'accident', canton: 'TG', url: 'https://kapo.tg.ch/route/rss-rss-getRss/entitylist/71/entitytype/80/lang/1' },
  // --- French-language police (Romandie)
  { id: 'police-vd', lang: 'fr', type: 'rss', kind: 'accident', canton: 'VD', url: 'https://www.vd.ch/djes/polcant/communiques-de-presse/flux.rss' },
  { id: 'police-ge', lang: 'fr', type: 'rss', kind: 'accident', canton: 'GE', url: 'https://www.ge.ch/rss/organisation/122' },
  { id: 'police-fr', lang: 'fr', type: 'rss', kind: 'accident', canton: 'FR', url: 'https://www.fr.ch/directions-services/113/rss.xml' },
  { id: 'police-ne', lang: 'fr', type: 'rss', kind: 'accident', canton: 'NE', url: 'https://www.ne.ch/actualites/18/rss.xml' },
  { id: 'police-vs', lang: 'fr', type: 'rss', kind: 'accident', canton: 'VS', url: 'https://www.policevalais.ch/category/communiques-pour-les-medias/feed/' },
  { id: 'police-ju', lang: 'fr', type: 'html-ju', kind: 'accident', canton: 'JU', url: 'https://www.jura.ch/pocommunique' },
  // --- Italian-language police (Ticino) – www4.ti.ch press page (no police RSS found)
  { id: 'police-ti', lang: 'it', type: 'html-ti', kind: 'accident', canton: 'TI', url: 'https://www4.ti.ch/tich/area-media/polizia-e-ministero' },
  // --- News search (Google News is robots-disallowed and will be skipped; Bing News RSS is used)
  ...NEWS_QUERIES.map(([q, lang, kind], n) => ({ id: `gnews-${lang}-${n}`, lang, type: 'rss', kind, url: gn(q, lang) })),
  ...NEWS_QUERIES.map(([q, lang, kind], n) => ({ id: `bing-${lang}-${n}`, lang, type: 'rss', kind, url: bing(q, lang) })),
  // --- Case law, all languages
  { id: 'entscheidsuche', lang: 'multi', type: 'entscheidsuche', kind: 'ruling', url: 'https://entscheidsuche.ch/_search.php',
    query: '("Arbeitsunfall" OR "Baustelle" OR "Arbeitssicherheit" OR "accident de travail" OR "chantier" OR "sécurité au travail" OR "infortunio sul lavoro" OR "cantiere" OR "sicurezza sul lavoro") AND (fahrlässig* OR "par négligence" OR colpos* OR "Art. 229" OR "art. 229" OR "Regeln der Baukunde" OR "règles de l\'art")' },
];

const robotsCache = new Map();
async function allowedByRobots(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    const rules = [];
    try {
      const r = await fetch(u.origin + '/robots.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        let applies = false, lastWasUA = false;
        for (const raw of (await r.text()).split('\n')) {
          const line = raw.split('#')[0].trim(); if (!line) continue;
          const i = line.indexOf(':'); const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
          if (k === 'user-agent') { applies = (lastWasUA && applies) || v === '*' || /safetyradar/i.test(v); lastWasUA = true; continue; }
          lastWasUA = false;
          if (applies && (k === 'allow' || k === 'disallow') && v) rules.push({ allow: k === 'allow', path: v });
        }
      }
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

const decode = s => (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#8217;|&rsquo;/g, '’').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/\s+/g, ' ').trim();
const tag = (x, t) => decode((x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);
const parseRss = xml => [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(([it]) => ({
  title: tag(it, 'title'), link: tag(it, 'link'), date: tag(it, 'pubDate') || tag(it, 'dc:date'),
  sourceName: tag(it, 'source') || null, categories: [...it.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/g)].map(m => decode(m[1])),
}));

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status); return r.text();
}

async function runSource(s) {
  if (!(await allowedByRobots(s.url))) return { items: [], note: 'skipped: robots.txt disallows' };
  if (s.type === 'entscheidsuche') {
    const body = { query: { bool: { must: { query_string: { query: s.query, default_operator: 'AND' } }, filter: { range: { date: { gte: 'now-180d' } } } } },
      size: 40, sort: [{ date: 'desc' }], _source: ['date', 'title', 'hierarchy', 'reference', 'attachment.content_url', 'attachment.language'] };
    const r = await fetch(s.url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return { items: j.hits.hits.map(h => { const lang = h._source.attachment?.language || 'de'; const ti = h._source.title || {};
      return { title: ti[lang] || ti.de || h._id, link: h._source.attachment?.content_url, date: h._source.date, sourceName: 'entscheidsuche.ch', lang,
        canton: (h._source.hierarchy?.[0] || '').length === 2 ? h._source.hierarchy[0] : null, reference: h._source.reference?.[0] }; }) };
  }
  const html = await get(s.url);
  if (s.type === 'html-ju') {
    const items = [...html.matchAll(/(\d{2})\.(\d{2})\.(\d{4})\s+\d{2}:\d{2}[\s\S]{0,400}?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map(m => ({ date: `${m[3]}-${m[2]}-${m[1]}`, link: new URL(m[4], s.url).toString(), title: decode(m[5]) })).filter(i => i.title);
    return { items };
  }
  if (s.type === 'html-ti') {
    const items = [...html.matchAll(/<a[^>]+href="([^"]*dettaglio-comunicato[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(m => ({ link: new URL(m[1], s.url).toString(), title: decode(m[2]) }));
    return { items };
  }
  return { items: parseRss(html) };
}

const norm = u => { try { let x = new URL(u); if (x.hostname.endsWith('bing.com') && x.searchParams.get('url')) x = new URL(x.searchParams.get('url'));
  x.hash = ''; [...x.searchParams.keys()].filter(k => /^utm_|^fbclid$|^gclid$/.test(k)).forEach(k => x.searchParams.delete(k)); return x.toString().replace(/\/$/, ''); } catch { return u; } };

async function main() {
  const queue = JSON.parse(await fs.readFile(QUEUE, 'utf8').catch(() => '[]'));
  const seen = new Set(queue.map(q => norm(q.url)));
  for (const f of PUBLISHED) for (const x of JSON.parse(await fs.readFile(f, 'utf8').catch(() => '[]'))) {
    seen.add(norm(x.source?.url || x.url)); (x.extraSources || []).forEach(s => seen.add(norm(s.url)));
  }
  const pubAcc = JSON.parse(await fs.readFile(PUBLISHED[0], 'utf8'));
  const sameEvent = (canton, date) => canton && date && pubAcc.some(a => a.canton === canton && Math.abs(new Date(a.date) - new Date(date)) <= 2 * 864e5);
  const report = [];
  for (const s of SOURCES) {
    const row = { source: s.id, lang: s.lang, fetched: 0, kept: 0, dropped: 0, dupes: 0, note: '' };
    try {
      const { items, note } = await runSource(s); row.fetched = items.length; row.note = note || '';
      for (const i of items) {
        const url = norm(i.link); if (!url) continue;
        if (seen.has(url)) { row.dupes++; continue; } seen.add(url);
        const lang = i.lang || s.lang;
        const c = classify({ title: i.title, url, lang, kind: s.kind, sourceCanton: s.canton, categories: i.categories, trusted: s.trusted, sourceType: s.type });
        const d = i.date ? new Date(i.date).toISOString().slice(0, 10) : null;
        if (c.keep && c.kind === 'accident' && sameEvent(i.canton || c.canton, d)) { c.keep = false; c.reason = 'probably already published (same canton ±2 days)'; }
        c.keep ? row.kept++ : row.dropped++;
        queue.push({ url, title: i.title, date: i.date ? new Date(i.date).toISOString().slice(0, 10) : null, kind: c.kind, lang,
          source: s.id, sourceName: i.sourceName || new URL(url).hostname.replace(/^www\./, ''), reference: i.reference,
          status: c.keep ? 'draft' : 'dropped', reason: c.reason, score: c.score,
          draft: c.keep ? { canton: i.canton || c.canton, industry: c.industry, hazard: c.hazard, outcome: c.outcome,
            title: null, facts: null, lesson: null, needs: ['verify facts from source', 'write facts + lesson in DE/FR/IT/EN'] } : undefined,
          fetchedAt: new Date().toISOString() });
      }
    } catch (e) { row.note = 'ERROR ' + (e.cause?.code || e.message); }
    report.push(row);
  }
  await fs.writeFile(QUEUE, JSON.stringify(queue, null, 2));
  console.table(report);
  const byLang = {}; for (const r of report) { byLang[r.lang] ??= { fetched: 0, kept: 0, dropped: 0 }; for (const k of ['fetched', 'kept', 'dropped']) byLang[r.lang][k] += r[k]; }
  console.log('Per language:'); console.table(byLang);
  console.log(`queue.json: ${queue.length} items (${queue.filter(q => q.status === 'draft').length} drafts awaiting review)`);
}
main();
