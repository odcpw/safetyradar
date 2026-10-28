// Feeds stage-2 reviewer decisions back to stage 1 (gitignored state), so handled items do not reappear in data/review.md.
//   data/queue.json       items whose URL went live -> status "published"; items the reviewer skipped -> status "rejected"
//   data/jobs-queue.json  same for job candidates
// Each touched item gets review: { date, decision, id?, reason? }. Matching is by normalised URL (also alsoReportedBy /
// alsoAt links) and, for skipped items given only by title, by exact title. Never throws on missing files.
import fs from 'node:fs';
import path from 'node:path';

export const normUrl = (u) => {
  try { const x = new URL(String(u).trim()); x.hash = ''; return (x.host.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase(); }
  catch { return null; }
};
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const urlsOfEntry = (e) => [e?.source?.url, e?.url, ...(e?.extraSources || []).map((s) => s.url), ...(e?.alsoAt || []).map((a) => a?.url || a)].filter(Boolean);
const urlsOfQueueItem = (q) => [q.url, ...(q.alsoReportedBy || []).map((a) => a.url), ...(q.alsoAt || []).map((a) => a?.url || a)].map(normUrl).filter(Boolean);
const URL_RE = /https?:\/\/[^\s)>\]"']+/g;

/**
 * @param dataDir  the live checkout's data/ (stage-1 state lives there)
 * @param summary  the reviewer's JSON answer (may be null)
 * @param changes  host diff: { "accidents.json": { added, removed, changed }, ... } – ids now on main
 * @param date     review date
 * @param opts     { dry: true } counts only, writes nothing
 */
export function applyFeedback(dataDir, summary, changes, date, opts = {}) {
  const published = new Map(); // normUrl -> entry id
  for (const [file, c] of Object.entries(changes || {})) {
    const entries = readJson(path.join(dataDir, file), []);
    const ids = new Set([...(c.added || []), ...(c.changed || [])]);
    for (const e of entries) if (ids.has(e.id)) for (const u of urlsOfEntry(e)) published.set(normUrl(u), e.id);
  }
  for (const x of [...(summary?.added || []), ...(summary?.merged || [])]) if (x?.source && normUrl(x.source)) published.set(normUrl(x.source), x.id ?? null);
  const rejected = new Map(), rejectedTitles = new Map();
  for (const s of summary?.skipped || []) {
    const reason = String(s?.reason ?? 'skipped by reviewer');
    const urls = [s?.url, ...String(s?.item ?? '').matchAll(URL_RE)].map((m) => (Array.isArray(m) ? m[0] : m)).filter(Boolean);
    for (const u of urls) if (normUrl(u)) rejected.set(normUrl(u), reason);
    if (!urls.length && s?.item) rejectedTitles.set(String(s.item).trim().toLowerCase(), reason);
  }
  const stats = {};
  for (const file of ['queue.json', 'jobs-queue.json']) {
    const f = path.join(dataDir, file);
    if (!fs.existsSync(f)) continue;
    const q = readJson(f, []);
    let pub = 0, rej = 0;
    for (const item of q) {
      const us = urlsOfQueueItem(item);
      const hit = us.find((u) => published.has(u));
      if (hit) { if (item.status !== 'published') pub++; item.status = 'published'; item.review = { date, decision: 'published', id: published.get(hit) }; continue; }
      if (item.status === 'published') continue;
      const ru = us.find((u) => rejected.has(u));
      const reason = ru ? rejected.get(ru) : rejectedTitles.get(String(item.title ?? '').trim().toLowerCase());
      if (reason) { if (item.status !== 'rejected') rej++; item.status = 'rejected'; item.review = { date, decision: 'rejected', reason }; }
    }
    stats[file] = { published: pub, rejected: rej };
    if (!opts.dry && (pub || rej)) fs.writeFileSync(f, JSON.stringify(q, null, 2));
  }
  return stats;
}

/** True when stage 2 already decided on the item (it must not be offered in review.md again). */
export const reviewed = (x) => x?.status === 'rejected' || x?.status === 'published';
