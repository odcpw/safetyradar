// Fedlex ELI bases (SR) for workplace-safety provisions we link from rulings.
// Fragment #art_N jumps to the article; Absätze live on the same page.
export const CODES = {
  StGB: { eli: 'cc/54/757_781_799', de: 'StGB', fr: 'CP', it: 'CP', en: 'SCC' },
  CP:   { eli: 'cc/54/757_781_799', de: 'StGB', fr: 'CP', it: 'CP', en: 'SCC' },
  SCC:  { eli: 'cc/54/757_781_799', de: 'StGB', fr: 'CP', it: 'CP', en: 'SCC' },
  UVG:  { eli: 'cc/1982/1676_1676_1676', de: 'UVG', fr: 'LAA', it: 'LAINF', en: 'UVG' },
  LAA:  { eli: 'cc/1982/1676_1676_1676', de: 'UVG', fr: 'LAA', it: 'LAINF', en: 'UVG' },
  LAINF:{ eli: 'cc/1982/1676_1676_1676', de: 'UVG', fr: 'LAA', it: 'LAINF', en: 'UVG' },
  BauAV:{ eli: 'cc/2021/384', de: 'BauAV', fr: 'OTConst', it: 'OLCostr', en: 'BauAV' },
  OTConst:{ eli: 'cc/2021/384', de: 'BauAV', fr: 'OTConst', it: 'OLCostr', en: 'BauAV' },
  OLCostr:{ eli: 'cc/2021/384', de: 'BauAV', fr: 'OTConst', it: 'OLCostr', en: 'BauAV' },
  VuV:  { eli: 'cc/1983/1968_1968_1968', de: 'VUV', fr: 'OPA', it: 'OPI', en: 'VUV' },
  VUV:  { eli: 'cc/1983/1968_1968_1968', de: 'VUV', fr: 'OPA', it: 'OPI', en: 'VUV' },
  OPA:  { eli: 'cc/1983/1968_1968_1968', de: 'VUV', fr: 'OPA', it: 'OPI', en: 'VUV' },
  ArG:  { eli: 'cc/1966/57_57_57', de: 'ArG', fr: 'LTr', it: 'LL', en: 'ArG' },
  LTr:  { eli: 'cc/1966/57_57_57', de: 'ArG', fr: 'LTr', it: 'LL', en: 'ArG' },
};

const LANG_PATH = { de: 'de', fr: 'fr', it: 'it', en: 'en' };

/** Build Fedlex URL for a code + article number (no Abs in fragment). */
export function fedlexUrl(code, artNum, lang = 'de') {
  const c = CODES[code];
  if (!c || !artNum) return null;
  const path = LANG_PATH[lang] || 'de';
  return `https://www.fedlex.admin.ch/eli/${c.eli}/${path}#art_${artNum}`;
}

/** Match Art./art. … Code in DE/FR/IT/EN charge text. */
export const ART_RE = /((?:Art\.|art\.)\s*(\d+[a-z]?)((?:\s*(?:Abs\.|al\.|cpv\.|para\.)\s*\d+[a-z]?(?:\s*(?:und|,|et|e|–|-)\s*\d+[a-z]?)*)?(?:\s*(?:lit\.|let\.|litt\.)\s*[a-z])?)?\s*(StGB|CP|SCC|UVG|LAA|LAINF|BauAV|OTConst|OLCostr|VuV|VUV|OPA|ArG|LTr))/gi;

/**
 * Split text into plain + link parts for Astro.
 * @returns {{type:'text'|'link', value:string, href?:string}[]}
 */
export function linkifyArticles(text, lang = 'de') {
  if (!text) return [];
  const out = [];
  let last = 0;
  const re = new RegExp(ART_RE.source, 'gi');
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    const href = fedlexUrl(m[4], m[2], lang);
    if (href) out.push({ type: 'link', value: m[1], href });
    else out.push({ type: 'text', value: m[1] });
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out.length ? out : [{ type: 'text', value: text }];
}
