#!/usr/bin/env node
// Explicit one-time operator migration, never invoked by the daily pipeline. Does NOT attest source verification.
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint, readLedger, writeLedger, reviewKey } from './lib/content-integrity.mjs';
const root = path.resolve(process.argv.find(a => a.startsWith('--root='))?.slice(7) || '.');
if (!process.argv.includes('--initialize-legacy')) throw new Error('Explicit --initialize-legacy required; preserves records as legacy_unreviewed, not verified');
const ledger = readLedger(root);
for (const kind of ['accidents', 'rulings']) {
 const file = path.join(root, 'data', kind + '.json');
 const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
 for (const entry of entries) {
  const key = reviewKey(kind, entry.id);
  if (ledger[key]) continue;
  const snapshot = structuredClone(entry);
  if (kind === 'rulings') {
   entry.caseStatus = 'unknown';
   for (const [i, d] of entry.defendants.entries()) {
    d.id = `d${i + 1}`;
    const strip = s => (s || '').replace(/\([^)]*(?:Art\.|art\.|Arts\.)[^)]*\)/g, '').replace(/\b(?:Art\.|art\.)\s*\d+[^;.]*/g, '').replace(/\s+/g, ' ').trim();
    d.allegations = d.charge ? [{ status: 'reported', offence: Object.fromEntries(['de','fr','it','en'].map(l => [l, strip(d.charge[l]) || ({de:'Vorwurf im Bericht',fr:'Infraction rapportée',it:'Imputazione riportata',en:'Reported allegation'})[l]])), articles: [] }] : [];
    delete d.charge; delete d.priorSanction;
    if (d.verdict !== 'convicted') d.sanction = null;
    d.sanctionHistory = [];
   }
  }
  ledger[key] = { state: 'legacy_unreviewed', hash: fingerprint(entry), at: new Date().toISOString(), method: 'conservative-model-migration-only', legacySnapshot: snapshot, issues: ['Source audit pending; unscoped article mappings and unstaged historical sanctions withheld'] };
 }
 fs.writeFileSync(file, JSON.stringify(entries, null, 1) + '\n');
}
writeLedger(root, ledger);
