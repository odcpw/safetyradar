import type { Lang } from './i18n/ui';
export const CANTONS: Record<string, string> = { AG:'Aargau',AI:'Appenzell I.Rh.',AR:'Appenzell A.Rh.',BE:'Bern / Berne',BL:'Basel-Landschaft',BS:'Basel-Stadt',FR:'Fribourg / Freiburg',GE:'Genève',GL:'Glarus',GR:'Graubünden / Grigioni',JU:'Jura',LU:'Luzern',NE:'Neuchâtel',NW:'Nidwalden',OW:'Obwalden',SG:'St. Gallen',SH:'Schaffhausen',SO:'Solothurn',SZ:'Schwyz',TG:'Thurgau',TI:'Ticino',UR:'Uri',VD:'Vaud',VS:'Valais / Wallis',ZG:'Zug',ZH:'Zürich',CH:'CH' };
const LOC: Record<Lang, string> = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH', en: 'en-GB' };
export const fmtDate = (d: string | null | undefined, lang: Lang = 'de') => d ? new Date(d + 'T12:00:00').toLocaleDateString(LOC[lang], { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
export const uniq = (a: (string | null | undefined)[]) => [...new Set(a.filter(Boolean) as string[])].sort();
export const byDateDesc = (k: string) => (a: any, b: any) => (b[k] || '').localeCompare(a[k] || '');

// v4: canton tile map layout [canton, col, row] (approximate geography, 7x5)
export const TILES: [string, number, number][] = [
  ['BS',2,0],['BL',3,0],['SH',4,0],['TG',5,0],
  ['JU',1,1],['SO',2,1],['AG',3,1],['ZH',4,1],['SG',5,1],['AR',6,1],
  ['NE',1,2],['BE',2,2],['LU',3,2],['ZG',4,2],['SZ',5,2],['AI',6,2],
  ['VD',0,3],['FR',1,3],['OW',2,3],['NW',3,3],['UR',4,3],['GL',5,3],['GR',6,3],
  ['GE',0,4],['VS',2,4],['TI',4,4],
];
export const countBy = (items: any[], f: (x: any) => string | null | undefined) => { const m: Record<string, number> = {}; items.forEach(x => { const k = f(x); if (k) m[k] = (m[k] || 0) + 1; }); return m; };
const NUM: Record<Lang, string> = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH', en: 'en-GB' };
export const monthName = (m: number, lang: Lang) => new Date(2000, m - 1, 15).toLocaleDateString(NUM[lang], { month: 'short' });
const chf = (n: number, lang: Lang) => n.toLocaleString(NUM[lang]);
// One-line sentence summary for a defendant's sanction; null parts omitted, never invented.
export const sanctionText = (s: any, lang: Lang, tt: (k: string) => string, pk: (v: any) => string | null) => {
  if (!s) return '';
  const parts: string[] = [];
  const cust = pk(s.custodial); if (cust) parts.push(cust);
  if (s.dailyUnits) parts.push(`${s.dailyUnits} ${tt('w.dayfines')} ${s.dailyAmount != null ? chf(s.dailyAmount, lang) : '?'}${s.suspended === true ? ' ' + tt('w.susp') : s.suspended === false ? ' ' + tt('w.unsusp') : ''}`);
  if (s.fineCHF) parts.push(`${tt('w.fine')} ${chf(s.fineCHF, lang)}`);
  const other = pk(s.other); if (other && !parts.length) parts.push(other);
  return parts.join(' + ');
};
