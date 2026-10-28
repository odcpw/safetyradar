import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyFeedback } from '../scripts/lib/review-feedback.mjs';

test('reviewer decisions mark stage-1 queue items published / rejected', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-fb-'));
  fs.writeFileSync(path.join(d, 'accidents.json'), JSON.stringify([{ id: 'a1', source: { url: 'https://www.x.ch/a/' }, extraSources: [{ url: 'https://y.ch/b' }] }]));
  fs.writeFileSync(path.join(d, 'jobs.json'), JSON.stringify([{ id: 'j1', url: 'https://jobs.ch/1' }]));
  fs.writeFileSync(path.join(d, 'queue.json'), JSON.stringify([
    { url: 'https://x.ch/a', title: 'A', status: 'draft' },
    { url: 'https://z.ch/c', title: 'C', status: 'draft', alsoReportedBy: [{ url: 'https://y.ch/b' }] },
    { url: 'https://crash.ch/d', title: 'Ambulance crash', status: 'draft' },
    { url: 'https://t.ch/e', title: 'Title only', status: 'draft' },
    { url: 'https://k.ch/f', title: 'Untouched', status: 'draft' }]));
  fs.writeFileSync(path.join(d, 'jobs-queue.json'), JSON.stringify([{ url: 'https://jobs.ch/1', status: 'new' }, { url: 'https://jobs.ch/2', status: 'new' }]));
  const ch = { 'accidents.json': { added: ['a1'], removed: [], changed: [] }, 'jobs.json': { added: ['j1'], removed: [], changed: [] } };
  const sum = { skipped: [{ item: 'https://crash.ch/d', reason: 'road traffic' }, { item: 'Title only', reason: 'unverifiable' }] };
  assert.deepEqual(applyFeedback(d, sum, ch, '2026-10-28', { dry: true })['queue.json'], { published: 2, rejected: 2 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'queue.json')))[0].status, 'draft'); // dry run writes nothing
  applyFeedback(d, sum, ch, '2026-10-28');
  const q = JSON.parse(fs.readFileSync(path.join(d, 'queue.json')));
  assert.deepEqual(q.map((x) => x.status), ['published', 'published', 'rejected', 'rejected', 'draft']);
  assert.equal(q[0].review.id, 'a1');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'jobs-queue.json'))).map((x) => x.status), ['published', 'new']);
});
