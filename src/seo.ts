// JSON-LD + feed helpers. Only fields that exist in our data; nothing inferred.
import { t, pick, LANGS, type Lang } from './i18n/ui';
import { CANTONS } from './lib';
export const SITE = 'https://safetyradar.ch';
const INLANG: Record<Lang, string> = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH', en: 'en' };
export const itemUrl = (lang: Lang, sec: string, id: string) => `${SITE}/${lang}/${sec}/${id}/`;
// Publication date we can stand behind: rulings carry `published` (release date); accidents only an event date.
export const pubDate = (item: any): string | null => item.published ?? null;
export function articleLd(item: any, lang: Lang, sec: 'accidents' | 'rulings') {
  const url = itemUrl(lang, sec, item.id);
  const sources = [item.source, ...(item.extraSources ?? [])].filter((s: any) => s?.url);
  const place = [item.place, item.canton && item.canton !== 'CH' ? CANTONS[item.canton] : null].filter(Boolean).join(', ');
  const art: any = {
    '@type': 'NewsArticle', '@id': url + '#article', mainEntityOfPage: url, url,
    headline: (pick(lang, item.title) ?? '').slice(0, 110), description: pick(lang, item.facts?.what) ?? undefined,
    inLanguage: INLANG[lang], isAccessibleForFree: true, image: `${SITE}/og.png`,
    author: { '@id': `${SITE}/#org` }, publisher: { '@id': `${SITE}/#org` },
    articleSection: t(lang, `nav.${sec}`),
    isBasedOn: sources.map((s: any) => s.url), citation: sources.map((s: any) => ({ '@type': 'CreativeWork', name: s.name, url: s.url })),
  };
  if (pubDate(item)) art.datePublished = pubDate(item);
  if (item.date) art.temporalCoverage = item.date; // event date (accidents) / decision date (rulings)
  if (place) art.contentLocation = { '@type': 'Place', name: place, address: { '@type': 'PostalAddress', addressCountry: 'CH', ...(item.canton && item.canton !== 'CH' ? { addressRegion: item.canton } : {}), ...(item.place ? { addressLocality: item.place } : {}) } };
  if (sec === 'rulings' && item.court) art.about = { '@type': 'Thing', name: [pick(lang, item.court), item.caseNumber].filter(Boolean).join(' ') };
  const crumbs = { '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Safety Radar', item: `${SITE}/${lang}/` },
    { '@type': 'ListItem', position: 2, name: t(lang, `nav.${sec}`), item: `${SITE}/${lang}/${sec}/` },
    { '@type': 'ListItem', position: 3, name: pick(lang, item.title) ?? item.id, item: url } ] };
  return [JSON.parse(JSON.stringify(art)), crumbs];
}
export const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const rfc822 = (d: string) => new Date(d.length === 7 ? d + '-01T12:00:00Z' : d + 'T12:00:00Z').toUTCString();
export function rss(lang: Lang, title: string, path: string, items: { title: string; link: string; desc?: string; date?: string | null; guid: string; cats?: string[] }[]) {
  const self = `${SITE}${path}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${esc(title)}</title>
<link>${SITE}/${lang}/</link>
<atom:link href="${self}" rel="self" type="application/rss+xml"/>
<description>${esc(t(lang, 'meta.description'))}</description>
<language>${INLANG[lang]}</language>
${items.map(i => `<item>
<title>${esc(i.title)}</title>
<link>${i.link}</link>
<guid isPermaLink="${i.guid === i.link}">${esc(i.guid)}</guid>${i.date ? `\n<pubDate>${rfc822(i.date)}</pubDate>` : ''}${i.desc ? `\n<description>${esc(i.desc)}</description>` : ''}${(i.cats ?? []).map(c => `\n<category>${esc(c)}</category>`).join('')}
</item>`).join('\n')}
</channel>
</rss>
`;
}
export { LANGS };
