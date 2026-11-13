import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedirectCookies } from '../scripts/lib/redirect-cookies.mjs';

const headers = (...cookies) => { const h = new Headers(); for (const c of cookies) h.append('set-cookie', c); return h; };

test('a self-redirect cookie (Tamedia pattern) is sent back on the next hop', () => {
  const jar = new RedirectCookies();
  const url = 'https://www.bernerzeitung.ch/arbeitsunfall-mit-fleischwolf-arbeitgeber-in-bern-gebuesst-587810503344';
  assert.equal(jar.header(url), null);
  jar.absorb(url, headers('entitlementToken=abc; Path=/; Secure', 'gbuuid=JQ; Path=/; Domain=.bernerzeitung.ch; Max-Age=1'));
  assert.equal(jar.header(url), 'entitlementToken=abc; gbuuid=JQ');
});

test('cookies stay with their domain; foreign Domain= attributes are ignored', () => {
  const jar = new RedirectCookies();
  jar.absorb('https://www.24heures.ch/x', headers('a=1', 'b=2; Domain=24heures.ch', 'evil=3; Domain=example.com'));
  assert.equal(jar.header('https://www.24heures.ch/y'), 'a=1; b=2');
  assert.equal(jar.header('https://m.24heures.ch/y'), 'b=2');      // domain cookie only, host-only cookie stays on www
  assert.equal(jar.header('https://example.com/'), null);
  assert.equal(jar.header('https://www.bernerzeitung.ch/'), null);
});

test('a later Set-Cookie replaces the earlier value', () => {
  const jar = new RedirectCookies();
  jar.absorb('https://a.ch/', headers('t=1'));
  jar.absorb('https://a.ch/', headers('t=2'));
  assert.equal(jar.header('https://a.ch/'), 't=2');
});
