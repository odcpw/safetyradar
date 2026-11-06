export const LESSON_LANGS = ['de', 'fr', 'it', 'en'];

export function lessonFromRefs(catalog, ids) {
  if (ids === null || (Array.isArray(ids) && ids.length === 0)) return null;
  if (!Array.isArray(ids) || ids.length > 2 || new Set(ids).size !== ids.length) {
    throw new Error('lesson requires 1–2 distinct catalog ids or null');
  }
  const selected = ids.map(id => {
    const ref = catalog.find(ref => ref.id === id);
    if (!ref) throw new Error(`unknown lesson ref: ${id}`);
    return ref;
  });
  return {
    ...Object.fromEntries(LESSON_LANGS.map(lang => [lang, selected.map(ref => ref.text[lang]).join(' ')])),
    refs: selected.map(({ id, label, url }) => ({ id, label, url })),
  };
}

export function lessonErrors(lesson, catalog) {
  if (lesson === null) return [];
  if (!lesson || typeof lesson !== 'object' || Array.isArray(lesson)) return ['lesson must be an object or null'];
  if (!Array.isArray(lesson.refs) || lesson.refs.length < 1 || lesson.refs.length > 2) return ['lesson.refs requires 1–2 catalog references'];
  if (lesson.refs.some(ref => !ref || typeof ref !== 'object' || typeof ref.id !== 'string')) return ['lesson.refs requires objects with catalog ids'];
  let expected;
  try { expected = lessonFromRefs(catalog, lesson.refs.map(ref => ref.id)); }
  catch (e) { return [e.message]; }
  const errors = [];
  for (const lang of LESSON_LANGS) {
    if (lesson[lang] !== expected[lang]) errors.push(`lesson.${lang} must copy the selected catalog text in ref order (no freeform tips)`);
  }
  lesson.refs.forEach((ref, i) => {
    if (ref.label !== expected.refs[i].label || ref.url !== expected.refs[i].url) errors.push(`lesson.refs[${i}] label/url must match the catalog`);
  });
  return errors;
}
