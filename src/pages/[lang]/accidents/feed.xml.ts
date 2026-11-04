import data from '../../../../data/accidents.json';
import { t, pick, LANGS, type Lang } from '../../../i18n/ui';
import { rss, itemUrl } from '../../../seo';
export const getStaticPaths = () => LANGS.map(lang => ({ params: { lang } }));
export const accidentItems = (lang: Lang) => [...data].sort((a: any, b: any) => (b.date || '').localeCompare(a.date || '')).map((i: any) => ({
  title: pick(lang, i.title) ?? i.id, link: itemUrl(lang, 'accidents', i.id), guid: itemUrl(lang, 'accidents', i.id),
  date: i.date, desc: pick(lang, i.facts?.what) ?? undefined, cats: [i.canton, i.industry, i.hazard].filter(Boolean) }));
export function GET({ params }: any) {
  const lang = params.lang as Lang;
  return new Response(rss(lang, `Safety Radar – ${t(lang, 'nav.accidents')}`, `/${lang}/accidents/feed.xml`, accidentItems(lang)), { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
