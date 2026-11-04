import data from '../../../../data/jobs.json';
import { t, tax, LANGS, type Lang } from '../../../i18n/ui';
import { rss } from '../../../seo';
export const getStaticPaths = () => LANGS.map(lang => ({ params: { lang } }));
// Jobs link to the original ad (we are not the employer and do not host the posting).
export function GET({ params }: any) {
  const lang = params.lang as Lang;
  const items = [...data].sort((a: any, b: any) => (b.datePosted || '').localeCompare(a.datePosted || '')).map((j: any) => ({
    title: `${j.title} – ${j.employer}`, link: j.url, guid: `https://safetyradar.ch/jobs/${j.id}`, date: j.datePosted,
    desc: `${j.employer} · ${j.location}${j.canton ? ` (${j.canton})` : ''} · ${tax(lang, 'role', j.role)} · ${t(lang, 'source')}: ${j.source}`, cats: [j.canton, j.role].filter(Boolean) }));
  return new Response(rss(lang, `Safety Radar – ${t(lang, 'nav.jobs')}`, `/${lang}/jobs/feed.xml`, items), { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
