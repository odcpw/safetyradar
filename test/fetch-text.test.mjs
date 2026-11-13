import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getText, fetchFollowingCookies } from '../scripts/lib/fetch-text.mjs';

// Tamedia pattern: the article 302s to itself and sets a cookie; only a request carrying it gets the page.
function server() {
  const s = http.createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (/(^|; )entitlement=ok(;|$)/.test(req.headers.cookie ?? '')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p>Arbeitsunfall mit Fleischwolf</p>'); }
    res.writeHead(302, { location: req.url, 'set-cookie': 'entitlement=ok; Path=/' }); res.end();
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

test('getText follows a self-redirect that sets a cookie (bernerzeitung/24heures pattern)', async () => {
  const s = await server();
  try {
    const t = await getText(`http://127.0.0.1:${s.address().port}/artikel-587810503344`, { fresh: true, cache: false });
    assert.equal(t, 'Arbeitsunfall mit Fleischwolf');
  } finally { s.close(); }
});

test('an endless redirect still fails (getText returns null instead of looping)', async () => {
  const s = await server();
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    await assert.rejects(fetchFollowingCookies(`${base}/loop`), /too many redirects/);
    assert.equal(await getText(`${base}/loop`, { fresh: true, cache: false }), null);
  } finally { s.close(); }
});
