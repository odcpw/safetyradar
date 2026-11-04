// Open data: the same JSON the site is built from (public repo odcpw/safetyradar, data/).
import accidents from '../../../data/accidents.json';
import rulings from '../../../data/rulings.json';
import jobs from '../../../data/jobs.json';
const SETS: Record<string, any[]> = { accidents, rulings, jobs };
export const getStaticPaths = () => Object.keys(SETS).map(name => ({ params: { name } }));
export function GET({ params }: any) {
  return new Response(JSON.stringify(SETS[params.name]), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
