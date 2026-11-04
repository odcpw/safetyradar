// Newsletter link tagging. Every link to safetyradar.ch in a newsletter issue gets
// utm_source=newsletter&utm_medium=email&utm_campaign=<issue>[&utm_content=a|b].
// Usage: import { issueId, tagUrl, tagHtml } from './scripts/lib/utm.mjs';
//   tagHtml(html, { campaign: issueId(new Date()), content: 'a' })
// CLI:  node scripts/lib/utm.mjs <file.html> [campaign] [a|b]  -> tagged HTML on stdout
const HOSTS = new Set(['safetyradar.ch', 'www.safetyradar.ch']);

/** ISO week id, e.g. 2026-w45 (Europe/Zurich calendar date). */
export function issueId(d = new Date()) {
  const [y, m, day] = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' }).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, day));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const wy = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(wy, 0, 1)) / 864e5 + 1) / 7);
  return `${wy}-w${String(week).padStart(2, '0')}`;
}

/** Add UTM params to one URL if it points to safetyradar.ch; other URLs are returned unchanged. */
export function tagUrl(url, { campaign, content } = {}) {
  if (!campaign) throw new Error('utm: campaign (issue id) required');
  if (content && !['a', 'b'].includes(content)) throw new Error('utm: content must be "a" or "b"');
  let u;
  try { u = new URL(url); } catch { return url; }
  if (!HOSTS.has(u.hostname)) return url;
  u.searchParams.set('utm_source', 'newsletter');
  u.searchParams.set('utm_medium', 'email');
  u.searchParams.set('utm_campaign', campaign);
  if (content) u.searchParams.set('utm_content', content); else u.searchParams.delete('utm_content');
  return u.toString();
}

/** Tag every href="https://safetyradar.ch/..." in an HTML string. */
export function tagHtml(html, opts) {
  return html.replace(/href=(["'])(https?:\/\/(?:www\.)?safetyradar\.ch[^"']*)\1/g,
    (_, q, url) => `href=${q}${tagUrl(url.replace(/&amp;/g, '&'), opts).replace(/&/g, '&amp;')}${q}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, campaign = issueId(), content] = process.argv.slice(2);
  if (!file) { console.error('usage: node scripts/lib/utm.mjs <file.html> [campaign] [a|b]'); process.exit(2); }
  const fs = await import('node:fs');
  process.stdout.write(tagHtml(fs.readFileSync(file, 'utf8'), { campaign, content }));
}
