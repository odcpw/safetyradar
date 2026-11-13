// Cookies set during ONE fetch's redirect chain, sent back on the next hops only (never persisted or shared).
// Some publishers (Tamedia: bernerzeitung.ch, 24heures.ch, tagesanzeiger.ch …) answer the first request with a 302 to the
// same URL plus a cookie; without echoing it, every hop redirects again ("too many redirects").
export class RedirectCookies {
  #jar = new Map(); // `${domain}\t${name}` -> { domain, hostOnly, name, value }
  absorb(url, headers) {
    const host = new URL(url).hostname.toLowerCase();
    const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get?.('set-cookie')].filter(Boolean);
    for (const line of lines) {
      const [pair, ...attrs] = String(line).split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
      let domain = host, hostOnly = true, foreign = false;
      for (const a of attrs) {
        const [k, v = ''] = a.split('=');
        if (k.trim().toLowerCase() !== 'domain') continue;
        const d = v.trim().replace(/^\./, '').toLowerCase();
        if (!d) continue;
        if (host === d || host.endsWith('.' + d)) { domain = d; hostOnly = false; } else foreign = true;
      }
      if (foreign) continue; // a cookie for another domain is rejected, as browsers do
      this.#jar.set(`${domain}\t${name}`, { domain, hostOnly, name, value });
    }
  }
  header(url) {
    const host = new URL(url).hostname.toLowerCase();
    const out = [...this.#jar.values()].filter((c) => c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain));
    return out.length ? out.map((c) => `${c.name}=${c.value}`).join('; ') : null;
  }
}
