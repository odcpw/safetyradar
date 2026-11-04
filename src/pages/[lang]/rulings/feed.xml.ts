import data from '../../../../data/rulings.json';
import { t, pick, LANGS, type Lang } from '../../../i18n/ui';
import { rss, itemUrl } from '../../../seo';
export const getStaticPaths = () => LANGS.map(lang => ({ params: { lang } }));
const d = (i: any) => i.published ?? i.date ?? i.firstSeen;
export const rulingItems = (lang: Lang) => [...data].sort((a: any, b: any) => (d(b) || '').localeCompare(d(a) || '')).map((i: any) => ({
  title: pick(lang, i.title) ?? i.id, link: itemUrl(lang, 'rulings', i.id), guid: itemUrl(lang, 'rulings', i.id),
  date: d(i), desc: pick(lang, i.facts?.what) ?? undefined, cats: [pick(lang, i.court), i.canton].filter(Boolean) as string[] }));
export function GET({ params }: any) {
  const lang = params.lang as Lang;
  return new Response(rss(lang, `Safety Radar – ${t(lang, 'nav.rulings')}`, `/${lang}/rulings/feed.xml`, rulingItems(lang)), { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
