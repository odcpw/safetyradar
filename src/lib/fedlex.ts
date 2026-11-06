import type { Lang } from '../i18n/ui';

const CODES: Record<string, { eli: string }> = {
  StGB: { eli: 'cc/54/757_781_799' }, CP: { eli: 'cc/54/757_781_799' }, SCC: { eli: 'cc/54/757_781_799' },
  UVG: { eli: 'cc/1982/1676_1676_1676' }, LAA: { eli: 'cc/1982/1676_1676_1676' }, LAINF: { eli: 'cc/1982/1676_1676_1676' },
  BauAV: { eli: 'cc/2021/384' }, OTConst: { eli: 'cc/2021/384' }, OLCostr: { eli: 'cc/2021/384' },
  VuV: { eli: 'cc/1983/1968_1968_1968' }, VUV: { eli: 'cc/1983/1968_1968_1968' }, OPA: { eli: 'cc/1983/1968_1968_1968' },
  ArG: { eli: 'cc/1966/57_57_57' }, LTr: { eli: 'cc/1966/57_57_57' },
};

export function fedlexUrl(code: string, artNum: string, lang: Lang = 'de'): string | null {
  const c = CODES[code];
  if (!c || !artNum) return null;
  const path = lang === 'en' ? 'en' : lang;
  return `https://www.fedlex.admin.ch/eli/${c.eli}/${path}#art_${artNum}`;
}

const ART_RE = /((?:Art\.|art\.)\s*(\d+[a-z]?)((?:\s*(?:Abs\.|al\.|cpv\.|para\.)\s*\d+[a-z]?(?:\s*(?:und|,|et|e|–|-)\s*\d+[a-z]?)*)?(?:\s*(?:lit\.|let\.|litt\.)\s*[a-z])?)?\s*(StGB|CP|SCC|UVG|LAA|LAINF|BauAV|OTConst|OLCostr|VuV|VUV|OPA|ArG|LTr))/gi;

export type ChargePart = { type: 'text' | 'link'; value: string; href?: string };

export function linkifyArticles(text: string, lang: Lang = 'de'): ChargePart[] {
  if (!text) return [];
  const out: ChargePart[] = [];
  let last = 0;
  const re = new RegExp(ART_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    const href = fedlexUrl(m[4], m[2], lang) || undefined;
    out.push(href ? { type: 'link', value: m[1], href } : { type: 'text', value: m[1] });
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out.length ? out : [{ type: 'text', value: text }];
}
