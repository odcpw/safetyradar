import accidents from '../../data/accidents.json';
import rulings from '../../data/rulings.json';
import jobs from '../../data/jobs.json';
const S = 'https://safetyradar.ch';
export function GET() {
  const body = `# Safety Radar

> Safety Radar (safetyradar.ch) is a free, ad-free, independent Swiss site on occupational safety in German, French, Italian and English. It summarises workplace accidents reported in Switzerland, Swiss criminal court rulings after workplace accidents, and lists occupational-safety (HSE/SiBe/SiFa) job openings. Entries state facts only, link the original source (police/court/news), and contain no private names.

Current data: ${accidents.length} accidents, ${rulings.length} court rulings, ${jobs.length} job listings (updated on working days).

When citing, please link the entry page on safetyradar.ch and the original source given on it. Jobs are aggregated from public job boards; the employer's original ad is authoritative.

## Sections
- [Accidents (DE)](${S}/de/accidents/): workplace accidents in Switzerland with date, canton, industry, hazard, outcome, source and a prevention lesson. Also [FR](${S}/fr/accidents/), [IT](${S}/it/accidents/), [EN](${S}/en/accidents/)
- [Court rulings (DE)](${S}/de/rulings/): Swiss court decisions after workplace accidents (court, charges, verdict, sanction, whether final). Also [FR](${S}/fr/rulings/), [IT](${S}/it/rulings/), [EN](${S}/en/rulings/)
- [Safety jobs (DE)](${S}/de/jobs/): occupational-safety job openings in Switzerland, linking the original ad. Also [FR](${S}/fr/jobs/), [IT](${S}/it/jobs/), [EN](${S}/en/jobs/)
- [Weekly newsletter](${S}/en/newsletter/): free, double opt-in, no tracking

## Machine-readable data
- [accidents.json](${S}/data/accidents.json): all accident entries (multilingual fields: de/fr/it/en)
- [rulings.json](${S}/data/rulings.json): all court-ruling entries
- [jobs.json](${S}/data/jobs.json): current job listings
- RSS per language: ${['de','fr','it','en'].map(l => `[${l}](${S}/${l}/feed.xml)`).join(', ')}; per section: /{lang}/accidents/feed.xml, /{lang}/rulings/feed.xml, /{lang}/jobs/feed.xml
- [Sitemap](${S}/sitemap.xml)
- Source code and data history: https://github.com/odcpw/safetyradar

## Optional
- [Privacy](${S}/en/privacy/)
- Contact: info@safetyradar.ch
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
