import { project } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { verifyClaims } = await import('../src/verify.mjs');
const { clusterClaims } = await import('../src/council.mjs');
const { renderReport } = await import('../src/report.mjs');
const { extractJson, completeShape } = await import('../src/json.mjs');
const { AGENT_SCHEMAS } = await import('../src/schemas.mjs');

const dir = project({ 'calc.js': 'function total(a, b) {\n  return a - b; // should add\n}\n' });

test('a real quote verifies; a made-up one is suspect; a plan point is neither', () => {
  const v = verifyClaims([
    { file: 'calc.js', line: 2, claim: 'subtracts', evidence: 'return a - b;' },
    { file: 'calc.js', line: 2, claim: 'invented', evidence: 'return a * b * c;' },
    { file: 'missing.js', line: 1, claim: 'no file', evidence: 'whatever it is' },
    { file: 'PLAN', line: null, claim: 'step 3 is missing', evidence: null },
  ], dir);
  assert.equal(v.verified, 1);
  assert.equal(v.suspect.length, 2);
  const report = renderReport({ verdict: 'block', confidence: 'high', summary: 's' }, v);
  assert.match(report, /verified against the files \(1\)/);
  assert.match(report, /not checkable against a file \(1\)/);
  assert.match(report, /Could not be confirmed \(2\)/);
});

test('a quote one line off still verifies, and says where it really is', () => {
  const v = verifyClaims([{ file: 'calc.js', line: 1, claim: 'x', evidence: 'return a - b;' }], dir);
  assert.equal(v.verified, 1);
  assert.equal(v.claims[0].foundAtLine, 2);
});

test('council clusters findings from different families on nearby lines', () => {
  const clusters = clusterClaims([
    { lane: 'codex', claims: [{ file: 'calc.js', line: 2, claim: 'a' }] },
    { lane: 'gemini', claims: [{ file: './calc.js', line: 3, claim: 'b' }, { file: 'calc.js', line: 40, claim: 'c' }] },
  ]);
  assert.equal(clusters.filter((k) => k.lanes.size === 2).length, 1);
  assert.equal(clusters.length, 2);
});

test('JSON is found inside prose, even with a stray brace after it', () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a": 1}\n```\nNote: use {curly} braces.'), { a: 1 });
  assert.deepEqual(extractJson('{"s": "a } inside"} trailing }'), { s: 'a } inside' });
  assert.equal(extractJson('no json here'), null);
  assert.deepEqual(extractJson('Use { to open a block. Answer: {"ok": true}'), { ok: true });
  assert.equal(extractJson('[1, 2]'), null);
});

test('a few missing fields are filled; too many is a malformed answer', () => {
  const schema = AGENT_SCHEMAS.jury;
  const full = { decision: 'pass', winner: 'A', rationale: 'r', ranking: [], merge_proposal: null, revision_request: null };
  const { revision_request: _, ...oneMissing } = full;
  assert.equal(completeShape(oneMissing, schema).revision_request, null);
  assert.equal(completeShape({ decision: 'pass' }, schema), null);
});
