import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { lessonFromRefs, lessonErrors, LESSON_LANGS } from '../scripts/lib/lesson-refs.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/lesson-refs.json', import.meta.url), 'utf8'));
const ids = ['bauav-art25-floor-opening', 'suva-67008-q03-full'];

test('lessons copy all languages and official document links deterministically', () => {
  const lesson = lessonFromRefs(catalog, ids);
  for (const lang of LESSON_LANGS) assert.equal(lesson[lang], ids.map(id => catalog.find(ref => ref.id === id).text[lang]).join(' '));
  assert.deepEqual(lesson.refs, ids.map(id => {
    const { label, url } = catalog.find(ref => ref.id === id);
    return { id, label, url };
  }));
  assert.deepEqual(lessonErrors(lesson, catalog), []);
  assert.equal(lessonFromRefs(catalog, null), null);
  assert.equal(lessonFromRefs(catalog, []), null);
  assert.deepEqual(lessonErrors(null, catalog), []);
});

test('freeform tips cannot be laundered through a genuine reference', () => {
  const lesson = lessonFromRefs(catalog, ids);
  for (const lang of LESSON_LANGS) {
    assert.match(lessonErrors({ ...lesson, [lang]: 'Invented advice' }, catalog).join(' '), /no freeform tips/);
  }
  assert.match(lessonErrors({ ...lesson, refs: [{ ...lesson.refs[0], url: 'https://example.com' }] }, catalog).join(' '), /label\/url/);
  assert.match(lessonErrors({ ...lesson, refs: [{ ...lesson.refs[0], label: 'Made-up citation' }] }, catalog).join(' '), /label\/url/);
});

test('invalid ids, duplicates, missing references and malformed lessons fail closed', () => {
  for (const invalid of [undefined, 'advice', [], {}, { de: 'old tip' }, { refs: [] }, { refs: [null] }, { refs: ['id'] }, { refs: [{ id: 'unknown' }] }]) {
    assert.ok(lessonErrors(invalid, catalog).length > 0, JSON.stringify(invalid));
  }
  assert.throws(() => lessonFromRefs(catalog, ['unknown']), /unknown/);
  assert.throws(() => lessonFromRefs(catalog, [ids[0], ids[0]]), /distinct/);
  assert.throws(() => lessonFromRefs(catalog, [...ids, 'vuv-art6-instruction']), /1–2/);
  const lesson = lessonFromRefs(catalog, ids);
  assert.ok(lessonErrors({ ...lesson, refs: [lesson.refs[0], lesson.refs[0]] }, catalog).length);
});

test('candidate lesson shape validator accepts null and rejects unreferenced, forged and altered lessons', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-lesson-test-'));
  try {
    for (const file of ['lesson-refs.json', 'accidents.json', 'rulings.json', 'jobs.json']) fs.copyFileSync(new URL(`../data/${file}`, import.meta.url), path.join(dir, file));
    const accidents = JSON.parse(fs.readFileSync(path.join(dir, 'accidents.json'), 'utf8'));
    const validate = lesson => {
      accidents[0].lesson = lesson;
      fs.writeFileSync(path.join(dir, 'accidents.json'), JSON.stringify(accidents));
      return spawnSync(process.execPath, ['scripts/validate-data.mjs', dir, '--candidate-shape'], { encoding: 'utf8' });
    };
    assert.equal(validate(null).status, 0);
    const valid = lessonFromRefs(catalog, ids);
    assert.equal(validate(valid).status, 0);
    const { refs, ...oldStyle } = valid;
    assert.equal(validate(oldStyle).status, 1);
    assert.equal(validate({ ...valid, en: 'Never do that!' }).status, 1);
    assert.equal(validate({ ...valid, refs: [{ id: 'nonexistent' }] }).status, 1);
    assert.equal(validate({ ...valid, refs: [{ ...refs[0], url: 'https://example.com' }] }).status, 1);
    fs.writeFileSync(path.join(dir, 'lesson-refs.json'), JSON.stringify([...catalog, catalog[0]]));
    assert.equal(validate(null).status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('keyword suggestions return only catalog references and no automatic lesson', () => {
  const hits = JSON.parse(execFileSync(process.execPath, ['scripts/match-lesson-refs.mjs', 'Gerüstbelag kippt'], { encoding: 'utf8' }));
  assert.ok(hits.some(hit => hit.id === 'suva-67038-q09-full'));
  assert.ok(hits.every(hit => catalog.some(ref => ref.id === hit.id && ref.url === hit.url)));
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['scripts/match-lesson-refs.mjs', 'unmatchedxyz'], { encoding: 'utf8' })), []);
});
