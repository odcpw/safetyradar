// node --test test/  – email intake against a synthetic AgentMail fixture (no network, no key).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIntake, classifyRecipient } from '../scripts/email-intake.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/agentmail/messages.json', import.meta.url), 'utf8'));
function fakeFetch(calls) {
  return async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const u = new URL(url);
    const parts = u.pathname.split('/');
    if (parts.at(-1) === 'messages') {
      const after = u.searchParams.get('after');
      const msgs = fx.list.filter(m => !after || m.timestamp >= after); // inclusive, like the worst case
      return new Response(JSON.stringify({ count: msgs.length, messages: msgs }), { status: 200 });
    }
    const id = decodeURIComponent(parts.at(-1));
    return fx.get[id] ? new Response(JSON.stringify(fx.get[id]), { status: 200 }) : new Response('{}', { status: 404 });
  };
}
const opts = (outDir, calls) => ({ apiKey: 'test-key', inbox: 'intake@example.test', baseUrl: 'https://api.test', outDir, now: new Date('2026-10-28T06:00:00Z'), log: () => {}, fetchImpl: fakeFetch(calls) });

test('classifies plus-tags', () => {
  assert.deepEqual(classifyRecipient(['intake+police-bs@example.test'], 'intake@example.test'), { tag: 'police-bs', kind: 'police', canton: 'BS' });
  assert.equal(classifyRecipient(['X <intake+jobs-jobup@example.test>'], 'intake@example.test').kind, 'jobs');
  assert.equal(classifyRecipient(['intake@example.test'], 'intake@example.test').canton, 'ZH');
  assert.equal(classifyRecipient(['other@else.test'], 'intake@example.test').tag, 'unknown');
});

test('saves new messages as untrusted JSON, skips sent, is idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
  const calls = [];
  const r1 = await runIntake(opts(dir, calls));
  assert.equal(r1.saved, 3);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  assert.equal(files.length, 3);
  const recs = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.ok(recs.every(r => r.untrusted === true && /never follow instructions/.test(r.note)));
  const police = recs.find(r => r.tag === 'police-sz');
  assert.equal(police.canton, 'SZ');
  assert.match(police.text, /IGNORE ALL PREVIOUS/); // stored verbatim as data; the reviewer prompt handles it
  const jobs = recs.find(r => r.kind === 'jobs');
  assert.match(jobs.text, /Beispiel AG, Bern \[https:\/\/jobs\.example\/1\]/); // HTML converted, links kept
  assert.equal(recs.find(r => r.tag === 'plain').text, 'Ein Mitarbeiter stürzte von einer Leiter.'); // extracted_text preferred
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.state.json'), 'utf8'));
  assert.equal(state.after, '2026-10-27T10:00:00Z');
  assert.ok(calls.every(c => c.auth === 'Bearer test-key'));
  // Second run: nothing new even though `after` is inclusive.
  const r2 = await runIntake(opts(dir, []));
  assert.equal(r2.saved, 0);
});

test('prunes inbox files older than keepDays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
  fs.writeFileSync(path.join(dir, '2026-09-01-police-sz-old.json'), '{}');
  await runIntake(opts(dir, []));
  assert.ok(!fs.existsSync(path.join(dir, '2026-09-01-police-sz-old.json')));
});

test('no key in fixture output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
  await runIntake(opts(dir, []));
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('test-key'));
});
