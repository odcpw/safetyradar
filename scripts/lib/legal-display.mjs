import { CODES } from './fedlex.mjs';
export function articleLabel(a, lang) {
 const code = CODES[a.code];
 if (!code) return '';
 const para = { de:'Abs.', fr:'al.', it:'cpv.', en:'para.' }[lang];
 const letter = { de:'lit.', fr:'let.', it:'lett.', en:'lit.' }[lang];
 return `${lang === 'de' || lang === 'en' ? 'Art.' : 'art.'} ${a.article}${a.paragraph ? ` ${para} ${a.paragraph}` : ''}${a.letter ? ` ${letter} ${a.letter}` : ''} ${code[lang]}`;
}
export function allegationText(a, lang, label) {
 const refs = a.articles.map(p => articleLabel(p, lang)).filter(Boolean).join('; ');
 return `${label(a.status)}: ${a.offence[lang]}${refs ? ` (${refs})` : ''}`;
}

// A disposed first-instance matter does not establish that the judgment is legally final.
export const publicCaseStatus = entry => entry.caseStatus === 'resolved' ? (entry.final === true ? 'resolved' : null) : entry.caseStatus === 'unknown' ? null : entry.caseStatus;
