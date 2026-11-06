import { getText } from './fetch-text.mjs';
import { entscheidsucheUrls } from './ruling-text.mjs';
export async function sourceDocuments(entry, fetcher = async url => ({ text: await getText(url, { fresh: true }) })) {
 const urls = [...new Set([...entscheidsucheUrls(entry), entry.source?.url, ...(entry.extraSources || []).map(s => s.url)].filter(Boolean))];
 const sources = [], failures = [];
 for (const url of urls) {
  try {
   const result = await fetcher(url);
   if (!result?.text || result.text.length < 400 || result.status >= 400) { failures.push({ url, reason: 'no usable source text' }); continue; }
   if (result.text.length > 200000) { failures.push({ url, reason: 'source too long: manual review required (no silent truncation)' }); continue; }
   sources.push({ url, text: result.text });
  } catch (e) { failures.push({ url, reason: e.message }); }
  if (sources.length === 2) break;
 }
 return { sources, failures };
}
