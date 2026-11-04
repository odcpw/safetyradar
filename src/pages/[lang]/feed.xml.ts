import { t, LANGS, type Lang } from '../../i18n/ui';
import { rss } from '../../seo';
import { accidentItems } from './accidents/feed.xml';
import { rulingItems } from './rulings/feed.xml';
export const getStaticPaths = () => LANGS.map(lang => ({ params: { lang } }));
export function GET({ params }: any) {
  const lang = params.lang as Lang;
  const items = [...accidentItems(lang), ...rulingItems(lang)].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 50);
  return new Response(rss(lang, `Safety Radar (${lang.toUpperCase()}) – ${t(lang, 'nav.accidents')} & ${t(lang, 'nav.rulings')}`, `/${lang}/feed.xml`, items), { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
