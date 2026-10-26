import type { Lang } from './i18n/ui';
export const CANTONS: Record<string, string> = { AG:'Aargau',AI:'Appenzell I.Rh.',AR:'Appenzell A.Rh.',BE:'Bern / Berne',BL:'Basel-Landschaft',BS:'Basel-Stadt',FR:'Fribourg / Freiburg',GE:'Genève',GL:'Glarus',GR:'Graubünden / Grigioni',JU:'Jura',LU:'Luzern',NE:'Neuchâtel',NW:'Nidwalden',OW:'Obwalden',SG:'St. Gallen',SH:'Schaffhausen',SO:'Solothurn',SZ:'Schwyz',TG:'Thurgau',TI:'Ticino',UR:'Uri',VD:'Vaud',VS:'Valais / Wallis',ZG:'Zug',ZH:'Zürich',CH:'CH' };
const LOC: Record<Lang, string> = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH', en: 'en-GB' };
export const fmtDate = (d: string | null | undefined, lang: Lang = 'de') => d ? new Date(d + 'T12:00:00').toLocaleDateString(LOC[lang], { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
export const uniq = (a: (string | null | undefined)[]) => [...new Set(a.filter(Boolean) as string[])].sort();
export const byDateDesc = (k: string) => (a: any, b: any) => (b[k] || '').localeCompare(a[k] || '');
