#!/usr/bin/env node
// Suggestions only: the reviewer must verify facts and source scope before choosing ids.
import fs from 'node:fs';
const query = process.argv.slice(2).join(' ');
if (!query.trim()) { console.error('Usage: node scripts/match-lesson-refs.mjs <hazard or keywords>'); process.exit(1); }
const normalize = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const terms = normalize(query).split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 3);
const catalog = JSON.parse(fs.readFileSync(new URL('../data/lesson-refs.json', import.meta.url), 'utf8'));
const hits = catalog.map(ref => {
  const haystack = normalize([ref.id, ref.label, ref.topic, ...(ref.keywords ?? [])].join(' '));
  return { id: ref.id, label: ref.label, url: ref.url, score: terms.filter(term => haystack.includes(term)).length };
}).filter(ref => ref.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
console.log(JSON.stringify(hits.slice(0, 8), null, 2));
