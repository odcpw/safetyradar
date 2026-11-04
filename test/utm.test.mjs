import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueId, tagUrl, tagHtml } from '../scripts/lib/utm.mjs';

test('issueId is ISO week', () => {
  assert.equal(issueId(new Date('2026-11-04T10:00:00Z')), '2026-w45');
  assert.equal(issueId(new Date('2027-01-01T10:00:00Z')), '2026-w53');
});
test('tagUrl tags only safetyradar.ch', () => {
  assert.equal(tagUrl('https://safetyradar.ch/de/?x=1', { campaign: '2026-w45', content: 'b' }),
    'https://safetyradar.ch/de/?x=1&utm_source=newsletter&utm_medium=email&utm_campaign=2026-w45&utm_content=b');
  assert.equal(tagUrl('https://example.com/', { campaign: '2026-w45' }), 'https://example.com/');
});
test('tagHtml rewrites hrefs, keeps others', () => {
  const out = tagHtml('<a href="https://safetyradar.ch/fr/">x</a><a href="https://bger.ch/">y</a>', { campaign: '2026-w45', content: 'a' });
  assert.match(out, /href="https:\/\/safetyradar\.ch\/fr\/\?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=2026-w45&amp;utm_content=a"/);
  assert.match(out, /href="https:\/\/bger\.ch\/"/);
});
