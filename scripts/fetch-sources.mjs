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
import { UA, allowedByRobots } from './lib/fetch-text.mjs';
// --since=YYYY-MM-DD widens the entscheidsuche window (default: last 180 days), e.g. `node scripts/fetch-sources.mjs --since=2023-01-01` for a backfill.
// --only=id1,id2 runs a subset of sources.
const ARG = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));

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
  // --- v4: regional/national media + official RSS from docs/source-audit.md (owner-approved RSS only; no email subscriptions).
  //     Not added: Südostschweiz (robots disallow), CH Media titles (Cloudflare 403, robots unreadable).
  { id: 'rsi-ticino', general: true, lang: 'it', type: 'rss', kind: 'accident', url: 'https://www.rsi.ch/info/ticino-grigioni-e-insubria/?f=rss' },
  { id: 'laregione-ticino', general: true, lang: 'it', type: 'rss', kind: 'accident', canton: 'TI', url: 'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_ticino.xml' },
  { id: 'tio-ticino', general: true, lang: 'it', type: 'rss', kind: 'accident', canton: 'TI', url: 'https://media.tio.ch/files/domains/tio.ch/rss/rss_ticino.xml' },
  { id: 'stadt-zuerich', general: true, lang: 'de', type: 'rss', kind: 'accident', canton: 'ZH', url: 'https://www.stadt-zuerich.ch/content/web/de/aktuell/medienmitteilungen/jcr:content/mainparsys/teaser.rss' },
  { id: 'stapo-winterthur', lang: 'de', type: 'rss', kind: 'accident', canton: 'ZH', url: 'https://www.stadtpolizei.ch/content/web/de/politik-und-verwaltung/stadtverwaltung/sid/stapo/jcr:content/mainparsys/teaser_copy.rss' },
  { id: 'kanton-uri', general: true, lang: 'de', type: 'rss', kind: 'accident', canton: 'UR', url: 'https://www.ur.ch/news-ur.rss' },
  { id: '24heures', general: true, lang: 'fr', type: 'rss', kind: 'accident', url: 'https://www.24heures.ch/rss.html' },
  { id: 'tdg', general: true, lang: 'fr', type: 'rss', kind: 'accident', url: 'https://www.tdg.ch/rss.html' },
  { id: 'tagesanzeiger', general: true, lang: 'de', type: 'rss', kind: 'accident', url: 'https://www.tagesanzeiger.ch/rss.html' },
  { id: 'bernerzeitung', general: true, lang: 'de', type: 'rss', kind: 'accident', url: 'https://www.bernerzeitung.ch/rss.html' },
  { id: 'baz', general: true, lang: 'de', type: 'rss', kind: 'accident', url: 'https://www.bazonline.ch/rss.html' },
  { id: 'srf-1890', general: true, lang: 'de', type: 'rss', kind: 'accident', url: 'https://www.srf.ch/news/bnf/rss/1890' },
  { id: 'srf-1646', general: true, lang: 'de', type: 'rss', kind: 'accident', url: 'https://www.srf.ch/news/bnf/rss/1646' },
  { id: 'rts-regions', general: true, lang: 'fr', type: 'rss', kind: 'accident', url: 'https://www.rts.ch/info/regions/?format=rss/news' },
  { id: '20min', general: true, lang: 'de', type: 'rss', kind: 'accident', url: 'https://partner-feeds.20min.ch/rss/20minuten' },
  { id: 'blick', general: true, lang: 'de', type: 'rss', kind: 'accident', url: 'https://www.blick.ch/news/rss.xml' },
  { id: 'watson', general: true, lang: 'de', type: 'rss', kind: 'accident', url: 'https://www.watson.ch/api/1.0/rss/index.xml' },
  // --- News search (Google News is robots-disallowed and will be skipped; Bing News RSS is used)
  ...NEWS_QUERIES.map(([q, lang, kind], n) => ({ id: `gnews-${lang}-${n}`, lang, type: 'rss', kind, url: gn(q, lang) })),
  ...NEWS_QUERIES.map(([q, lang, kind], n) => ({ id: `bing-${lang}-${n}`, lang, type: 'rss', kind, url: bing(q, lang) })),
  // --- Case law, all languages
  { id: 'entscheidsuche', lang: 'multi', type: 'entscheidsuche', kind: 'ruling', url: 'https://entscheidsuche.ch/_search.php',
    query: '("Arbeitsunfall" OR "Baustelle" OR "Arbeitssicherheit" OR "accident de travail" OR "chantier" OR "sécurité au travail" OR "infortunio sul lavoro" OR "cantiere" OR "sicurezza sul lavoro") AND (fahrlässig* OR "par négligence" OR colpos* OR "Art. 229" OR "art. 229" OR "Regeln der Baukunde" OR "règles de l\'art")' },
];

const decode = s => (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#8217;|&rsquo;/g, '’').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/\s+/g, ' ').trim();
const tag = (x, t) => decode((x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);
const parseAtom = xml => [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)].map(([it]) => ({
  title: tag(it, 'title'), link: (it.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '', date: tag(it, 'updated') || tag(it, 'published'), sourceName: null, categories: [],
}));
const parseRss = xml => /<feed[\s>]/.test(xml.slice(0, 500)) && !/<item[\s>]/.test(xml) ? parseAtom(xml) : [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(([it]) => ({
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
    const body = { query: { bool: { must: { query_string: { query: s.query, default_operator: 'AND' } }, filter: { range: { date: { gte: ARG.since || 'now-180d' } } } } },
      size: ARG.since ? 300 : 40, sort: [{ date: 'desc' }], _source: ['date', 'title', 'hierarchy', 'reference', 'attachment.content_url', 'attachment.language'] };
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
  // Cross-source dedupe: the same event reported by several outlets merges into one candidate that keeps every source link.
  const toks = t => new Set((t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 3));
  const sim = (a, b) => { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach(w => B.has(w) && n++); return n / Math.min(A.size, B.size); };
  // Already published = same canton, ±2 days AND the title names the published place (or closely matches a published title).
  const fold = x => (x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const sameEvent = (canton, date, title) => canton && date && pubAcc.some(a => a.canton === canton && Math.abs(new Date(a.date) - new Date(date)) <= 2 * 864e5
    && ((a.place && fold(title).includes(fold(a.place).split(/[ /(]/)[0])) || Object.values(a.title || {}).some(t => sim(t, title) >= 0.5)));
  const report = [];
  const findSame = (kind, canton, date, title) => queue.find(q => q.status === 'draft' && q.kind === kind && q.date && date && Math.abs(new Date(q.date) - new Date(date)) <= 1.5 * 864e5
    && ((canton && q.draft?.canton === canton && sim(q.title, title) >= 0.25) || sim(q.title, title) >= 0.5));
  const sources = ARG.only ? SOURCES.filter(s => ARG.only.split(',').includes(s.id)) : SOURCES;
  for (const s of sources) {
    const row = { source: s.id, lang: s.lang, fetched: 0, kept: 0, merged: 0, dropped: 0, dupes: 0, note: '' };
    try {
      const { items, note } = await runSource(s); row.fetched = items.length; row.note = note || '';
      for (const i of items) {
        const url = norm(i.link); if (!url) continue;
        if (seen.has(url)) { row.dupes++; continue; } seen.add(url);
        const lang = i.lang || s.lang;
        const c = classify({ title: i.title, url, lang, kind: s.kind, sourceCanton: s.canton, categories: i.categories, trusted: s.trusted, sourceType: s.type, general: s.general });
        const d = i.date ? new Date(i.date).toISOString().slice(0, 10) : null;
        if (c.keep && c.kind === 'accident' && sameEvent(i.canton || c.canton, d, i.title)) { c.keep = false; c.reason = 'probably already published (same canton ±2 days)'; }
        if (c.keep) { const same = findSame(c.kind, i.canton || c.canton, d, i.title);
          if (same) { (same.alsoReportedBy ??= []).push({ url, title: i.title, source: s.id, lang }); row.merged++; continue; } }
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
  const byLang = {}; for (const r of report) { byLang[r.lang] ??= { fetched: 0, kept: 0, merged: 0, dropped: 0 }; for (const k of ['fetched', 'kept', 'merged', 'dropped']) byLang[r.lang][k] += r[k]; }
  console.log('Per language:'); console.table(byLang);
  console.log(`queue.json: ${queue.length} items (${queue.filter(q => q.status === 'draft').length} drafts awaiting review)`);
}
main();
