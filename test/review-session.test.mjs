import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewSession } from '../scripts/lib/review-session.mjs';

test('a run that never started gets a fresh session, so a stored answer is never replayed', () => {
  assert.equal(reviewSession({ phase: 'agent' }, '2026-11-13', () => 'abc12345'), '2026-11-13-abc12345');
  assert.equal(reviewSession(undefined, '2026-11-13', () => 'x'), '2026-11-13-x');
  const a = reviewSession({}, '2026-11-13'), b = reviewSession({}, '2026-11-13');
  assert.notEqual(a, b);
  assert.match(a, /^2026-11-13-[0-9a-f]{8}$/);
});

test('a started run resumes its own session; legacy started runs resume the bare date tag', () => {
  assert.equal(reviewSession({ started: true, session: '2026-11-13-abc12345' }, '2026-11-13', () => 'new'), '2026-11-13-abc12345');
  assert.equal(reviewSession({ started: true }, '2026-11-13', () => 'new'), '2026-11-13');
});
