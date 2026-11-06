import test from 'node:test';
import assert from 'node:assert/strict';
import { supportedProposal } from './enrich-ruling-injuries.mjs';
import { entscheidsucheUrls } from './lib/ruling-text.mjs';
const text = 'Er erlitt eine komplexe Hand- und Unterarmverletzung links mit multiplen Schnittverletzungen.';
const proposal = { action: 'improve', sourceKind: 'decision', injuries: { de: 'Schnittverletzungen an Hand und Unterarm links', fr: 'Coupures à la main et à l’avant-bras gauches', it: 'Tagli alla mano e all’avambraccio sinistri', en: 'Cuts to the left hand and forearm' }, evidence: [text] };
test('accepts an injury phrase backed by a verbatim court excerpt', () => assert.equal(supportedProposal(proposal, text), true));
test('rejects invented evidence, news, missing translations and overlong text', () => {
  for (const p of [
    { ...proposal, evidence: ['Amputation der linken Hand'] },
    { ...proposal, sourceKind: 'news' },
    { ...proposal, injuries: { de: 'Verletzt' } },
    { ...proposal, injuries: { ...proposal.injuries, en: 'x'.repeat(241) } },
    { ...proposal, evidence: [] },
  ]) assert.equal(Boolean(supportedProposal(p, text)), false);
});
test('evidence tolerates layout whitespace only', () => {
  assert.equal(supportedProposal(proposal, text.replace('Unterarmverletzung links', 'Unterarmverletzung\n links')), true);
});
test('BGer case number resolves to the established decision mirror', () => {
  assert.deepEqual(entscheidsucheUrls({ caseNumber: '7B_1323/2024', date: '2026-07-03' }), ['https://entscheidsuche.ch/docs/CH_BGer/CH_BGer_007_7B-1323-2024_2026-07-03.html']);
});
