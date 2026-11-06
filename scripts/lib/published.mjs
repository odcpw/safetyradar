// Publication dates for rulings. `published` = the date the source itself shows the ruling was released:
//  - Federal Supreme Court: the bger.ch "Neue Entscheide" day list ("Liste der am DD.MM.YYYY neu aufgenommenen Entscheide")
//    that first contains the case number (scanned from the decision date forward).
//  - News report: the article's own datePublished / article:published_time.
//  - Otherwise null (never guessed). `firstSeen` (the day Safety Radar first fetched the item) is the separate fallback.
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';

// bger.ch does not send its intermediate certificate (public CA cert, not a secret); add the public DigiCert intermediate for this host only.
const CA = [...tls.rootCertificates, fs.readFileSync(new URL('./certs/digicert-global-g2-tls-rsa-sha256-2020-ca1.crt', import.meta.url), 'utf8')];
const UA = 'Mozilla/5.0 (compatible; SafetyRadarBot/1.0; +https://safetyradar.ch)';
const get = url => new Promise((res, rej) => {
  const r = https.get(url, { ca: CA, headers: { 'User-Agent': UA }, timeout: 30000 }, x => {
    if (x.statusCode !== 200) { x.resume(); return rej(new Error('HTTP ' + x.statusCode)); }
    const b = []; x.on('data', c => b.push(c)); x.on('end', () => res(Buffer.concat(b).toString('latin1')));
  });
  r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', rej);
});
const ymd = d => d.toISOString().slice(0, 10);
const dmy = d => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
const pages = new Map();
async function bgerDay(d) {
  const key = ymd(d).replace(/-/g, '');
  if (!pages.has(key)) pages.set(key, get(`https://www.bger.ch/ext/eurospider/live/de/php/aza/http/index_aza.php?date=${key}&lang=de&mode=news`)
    .then(s => new RegExp(`Liste der am(?:&nbsp;|\\s)*<b>${dmy(d).replace(/\./g, '\\.')}`).test(s) ? new Set(s.match(/\d[A-Z]_\d+\/\d{4}/g) || []) : null));
  return pages.get(key);
}
/** First bger.ch "Neue Entscheide" day listing `caseNumber` (e.g. "6B_341/2025"), or null if not found / a day failed to load. */
export async function bgerPublished(caseNumber, decisionDate, maxDays = 150) {
  const num = String(caseNumber || '').match(/\d[A-Z]_\d+\/\d{4}/)?.[0]; if (!num || !decisionDate) return null;
  const today = new Date();
  for (let i = 0; i <= maxDays; i++) {
    const d = new Date(decisionDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
    if (d > today) return null; if (d.getUTCDay() % 6 === 0) continue;
    const list = await bgerDay(d).catch(() => undefined);
    if (list === undefined) return null; // a failed day could hide the real date: give up rather than report a later one
    if (list?.has(num)) return ymd(d);
  }
  return null;
}
/** The article's own publication date from its HTML metadata (Europe/Zurich calendar day), or null. */
export function articlePublished(html) {
  const m = String(html || '').match(/\\?"datePublished\\?"\s*:\s*\\?"([^"\\]+)|article:published_time"\s+content="([^"]+)"|content="([^"]+)"\s+property="article:published_time"/);
  const t = m && new Date(m[1] || m[2] || m[3]); if (!t || isNaN(t)) return null;
  return t.toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
}
export async function fetchArticlePublished(url) {
  try { const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) }); return r.ok ? articlePublished(await r.text()) : null; } catch { return null; }
}
/** { published, publishedSource } for a ruling entry/draft (court, caseNumber, date, source.url). */
export async function findPublished(e) {
  const url = e.source?.url || e.url || '';
  const fed = /bger|bundesgericht|tribunal fédéral/i.test(`${url} ${e.court?.de || ''} ${e.court?.fr || ''}`) && /\d[A-Z]_\d+\/\d{4}/.test(e.caseNumber || '');
  if (fed) { const p = await bgerPublished(e.caseNumber, e.date); return p ? { published: p, publishedSource: 'bger.ch Neue Entscheide' } : { published: null, publishedSource: null }; }
  if (/entscheidsuche\.ch|justice\.|gerichte|zsg-entscheide|tribuna/i.test(url)) return { published: null, publishedSource: null }; // court portals show no release date
  const p = await fetchArticlePublished(url);
  return p ? { published: p, publishedSource: 'article datePublished' } : { published: null, publishedSource: null };
}

/** Confirm an unchanged release date without changing the selection algorithm or guessing precision. */
export async function publishedEvidence(e) {
  if (!e.published) return { status: 'no-release-date-claimed', published: null };
  const url = e.source?.url || '';
  const num = String(e.caseNumber || '').match(/\d[A-Z]_\d+\/\d{4}/)?.[0];
  const fed = num && /bger|bundesgericht|tribunal fédéral/i.test(`${url} ${e.court?.de || ''} ${e.court?.fr || ''}`);
  if (fed) {
    const d = new Date(e.published + 'T00:00:00Z');
    if (isNaN(d)) return { status: 'hold', reason: 'invalid release date' };
    const list = await bgerDay(d).catch(() => null);
    return list?.has(num) ? { status: 'confirmed', published: e.published, publishedSource: 'bger.ch Neue Entscheide', caseNumber: num, sourceUrl: `https://www.bger.ch/ext/eurospider/live/de/php/aza/http/index_aza.php?date=${e.published.replace(/-/g,'')}&lang=de&mode=news`, method: 'exact dated release-list membership; original selection unchanged' } : { status: 'hold', reason: 'claimed release-list membership unavailable or unconfirmed' };
  }
  const date = await fetchArticlePublished(url);
  return date === e.published ? { status: 'confirmed', published: date, publishedSource: 'article datePublished', sourceUrl: url, method: 'fresh article metadata' } : { status: 'hold', reason: 'claimed article publication date unavailable or contradicted', observed: date };
}
