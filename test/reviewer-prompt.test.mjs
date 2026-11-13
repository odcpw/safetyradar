import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemPrompt } from '../reviewer/src/prompt.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the reviewer is told the host review runs on its upserts, so it must not self-hold for it', () => {
  const p = systemPrompt(ROOT);
  assert.match(p, /host review runs AUTOMATICALLY after your final answer/);
  assert.match(p, /never hold a candidate\s+because the host\/independent review has not happened yet/);
  assert.match(p, /If the fetched source supports the facts, upsert_entry it\./);
  // The accuracy rules and the gate itself stay in force.
  assert.match(p, /Every proposal passes an independent host source\/evidence gate/);
  assert.match(p, /A separate high-effort structured source review must approve every dimension/);
});

test('run_checks no longer tells the agent its candidates are "NOT approved"', () => {
  const tools = fs.readFileSync(path.join(ROOT, 'reviewer/src/tools.ts'), 'utf8');
  assert.doesNotMatch(tools, /NOT approved for publication/);
  assert.match(tools, /return text\(RUN_CHECKS_OK\)/);
  assert.match(tools, /export const RUN_CHECKS_OK = "Shape checks passed\. After your final answer the host automatically verifies/);
});

test('the host gate is unchanged: every new/changed accident or ruling is still verified before acceptance', () => {
  const main = fs.readFileSync(path.join(ROOT, 'reviewer/src/main.ts'), 'utf8');
  assert.match(main, /const gated = await gateCollection\(\{ kind, before, candidates,/);
  assert.match(main, /const result = await verifyContent\(\{ entry, kind, sources, publicationEvidence: provenance, catalog \}\);/);
  assert.match(main, /if \(!sources\.length\) return \{ state: "held", issues: \["source unavailable; previous data retained"\] \};/);
});
