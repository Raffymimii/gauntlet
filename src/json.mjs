// Getting a JSON object out of a model's answer, which may be fenced, wrapped in
// prose, or followed by a sentence containing a stray brace.

/** Index of the brace closing the object opened at `start`, skipping strings; -1 if none. */
function closingBrace(s, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_CANDIDATES = 200; // keeps a long answer full of stray braces from going quadratic

/** The first balanced object that parses, or null. */
export function extractJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (isPlainObject(v)) return v;
  } catch { /* look inside */ }
  let tried = 0;
  for (let start = s.indexOf('{'); start !== -1 && tried < MAX_CANDIDATES; start = s.indexOf('{', start + 1), tried++) {
    // An unclosed brace in the prose before the object is skipped, not the end of the search.
    const end = closingBrace(s, start);
    if (end === -1) continue;
    try {
      const v = JSON.parse(s.slice(start, end + 1));
      if (isPlainObject(v)) return v;
    } catch { /* try the next one */ }
  }
  return null;
}

export function hasRequiredKeys(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (schema.required || []).every((k) => k in value);
}

function emptyOf(prop) {
  const types = Array.isArray(prop?.type) ? prop.type : [prop?.type];
  if (types.includes('null')) return null;
  if (types.includes('array')) return [];
  if (types.includes('boolean')) return false;
  if (types.includes('integer') || types.includes('number')) return 0;
  return '';
}

/**
 * Models drop a secondary field of a long contract now and then. Up to a third of the
 * required keys may be missing; they get empty values of their type. Anything worse is
 * a malformed answer and returns null.
 */
export function completeShape(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const required = schema.required || [];
  const missing = required.filter((k) => !(k in value));
  if (missing.length * 3 > required.length) return null;
  const out = { ...value };
  for (const k of missing) out[k] = emptyOf(schema.properties?.[k]);
  return out;
}
