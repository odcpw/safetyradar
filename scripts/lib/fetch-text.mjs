// Polite fetching shared by the pipeline: robots.txt check (RFC 9309 longest match) and a cached
// HTML->text fetch for ruling documents (cache: data/cache/text/<hash>.txt, gitignored).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
export const UA = 'SafetyRadarBot/0.2 (+https://safetyradar.ch)';

const robotsCache = new Map();
export async function allowedByRobots(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    const rules = [];
    try {
      const r = await fetch(u.origin + '/robots.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        let applies = false, lastWasUA = false;
        for (const raw of (await r.text()).split('\n')) {
          const line = raw.split('#')[0].trim(); if (!line) continue;
          const i = line.indexOf(':'); const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
          if (k === 'user-agent') { applies = (lastWasUA && applies) || v === '*' || /safetyradar/i.test(v); lastWasUA = true; continue; }
          lastWasUA = false;
          if (applies && (k === 'allow' || k === 'disallow') && v) rules.push({ allow: k === 'allow', path: v });
        }
      }
    } catch { /* unreachable robots => treat as allowed */ }
    robotsCache.set(u.origin, rules);
  }
  const p = u.pathname + u.search; let best = null;
  for (const rule of robotsCache.get(u.origin)) {
    const re = new RegExp('^' + rule.path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(p) && (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow))) best = rule;
  }
  return !best || best.allow;
}

export const htmlToText = h => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;/g, '’')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

const CACHE = new URL('../../data/cache/text/', import.meta.url);
/** Fetch a public document as plain text (robots-respecting, cached on disk). Returns null if disallowed/failed. */
export async function getText(url) {
  const f = new URL(createHash('sha1').update(url).digest('hex').slice(0, 16) + '.txt', CACHE);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  if (!(await allowedByRobots(url))) return null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) return null;
    let t;
    if (/pdf/.test(ct) || /\.pdf$/i.test(new URL(url).pathname)) {
      // PDFs need poppler's pdftotext; without it the document is skipped (reviewer reads it manually).
      const tmp = path.join(os.tmpdir(), `sr-${process.pid}-${Date.now()}.pdf`);
      fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      try { t = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', tmp, '-'], { encoding: 'utf8', maxBuffer: 32e6 }); }
      catch { return null; } finally { fs.rmSync(tmp, { force: true }); }
      t = t.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    } else if (/text|html/.test(ct)) t = htmlToText(await r.text());
    else return null;
    fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, t);
    return t;
  } catch { return null; }
}
