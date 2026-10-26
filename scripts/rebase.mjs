// Post-build: prefix root-relative links with the deploy base (e.g. /safetyradar) and, for previews, block indexing.
import fs from 'node:fs'; import path from 'node:path';
const base = (process.env.BASE || '/').replace(/\/$/, '');
const dist = new URL('../dist/', import.meta.url).pathname;
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
let n = 0;
if (base) for (const f of walk(dist).filter(f => f.endsWith('.html'))) {
  const s = fs.readFileSync(f, 'utf8');
  const esc = base.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = s.replace(new RegExp(`(href|src|action)="/(?!/|${esc}/)`, 'g'), `$1="${base}/`).replace(/url=\/(?!\/)/g, `url=${base}/`);
  if (out !== s) { fs.writeFileSync(f, out); n++; }
}
if (process.env.NOINDEX === '1') fs.writeFileSync(path.join(dist, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log(`rebase: base="${base || '/'}", rewrote ${n} files, noindex=${process.env.NOINDEX === '1'}`);
