// Post-build: prefix root-relative links with the deploy base (e.g. /safetyradar) and write sitemap.xml.
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
// sitemap.xml: every built page except the root redirect and 404.
const site = (process.env.SITE || 'https://safetyradar.ch').replace(/\/$/, '');
const urls = walk(dist).filter(f => f.endsWith('index.html')).map(f => '/' + path.relative(dist, f).replace(/index\.html$/, ''))
  .filter(u => u !== '/').sort();
fs.writeFileSync(path.join(dist, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + urls.map(u => `<url><loc>${site}${base}${u}</loc></url>`).join('\n') + '\n</urlset>\n');
console.log(`rebase: base="${base || '/'}", rewrote ${n} files, sitemap ${urls.length} urls`);
