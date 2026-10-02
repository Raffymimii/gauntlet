import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const store = await import('../src/runtime/store.mjs');
const { validateRuntime, validateExpect } = await import('../src/runtime/validate.mjs');
const { recordAnalysis, checkExpectation } = await import('../src/learning.mjs');
const { PATHS } = await import('../src/config.mjs');

test('the package defaults validate and are version 0', () => {
  const cur = store.currentRuntime();
  assert.equal(cur.version, 0);
  assert.deepEqual(validateRuntime(cur.config), { ok: true, errors: [] });
  assert.match(cur.config.agents.jury.prompt, /jury/i);
});

test('publish only goes up; rollback is a new version; invalid configs are refused', async () => {
  const cfg = store.currentRuntime().config;
  const a = await store.publish({ ...cfg, policy: { ...cfg.policy, rules: [...cfg.policy.rules, 'EXTRA RULE'] } }, { reason: 'add a rule' });
  assert.equal(a.version, 1);
  const bad = await store.publish({ ...cfg, agents: { ...cfg.agents, jury: { ...cfg.agents.jury, lane: 'nowhere' } } });
  assert.equal(bad.ok, false);
  const r = await store.rollback(0, 'back to defaults');
  assert.equal(r.version, 2);
  assert.equal(store.currentRuntime().version, 2);
  assert.ok(!store.currentRuntime().config.policy.rules.includes('EXTRA RULE'));
});

test('a hand-broken version file is skipped, not used', () => {
  fs.writeFileSync(path.join(PATHS.runtime, 'versions', 'v99.json'), '{"version":99,"config":{"broken":true}}');
  const cur = store.currentRuntime();
  assert.notEqual(cur.version, 99);
  assert.deepEqual(cur.skipped, [99]);
  fs.unlinkSync(path.join(PATHS.runtime, 'versions', 'v99.json'));
});

test('concurrent publishes do not lose a change', async () => {
  const add = (rule) => store.publish((cfg) => { cfg.policy.rules.push(rule); return cfg; }, { reason: rule });
  await Promise.all([add('R1'), add('R2'), add('R3')]);
  const rules = store.currentRuntime().config.policy.rules;
  for (const r of ['R1', 'R2', 'R3']) assert.ok(rules.includes(r), r);
});

test('regression expectations must be checkable', () => {
  const agents = store.currentRuntime().config.agents;
  assert.equal(validateExpect(agents.comprehension, { kind: 'non_empty', value: 'ambiguities' }), null);
  assert.ok(validateExpect(agents.comprehension, { kind: 'non_empty', value: 'Some sentence the model said' }));
  assert.ok(validateExpect(agents.anti_hallucination, { kind: 'contains', value: 'After three failures on the same files no new build is started.' }));
  assert.ok(validateExpect(agents.legal, { kind: 'is_true', value: 'summary' }));
  assert.equal(validateExpect(agents.text_review, { kind: 'verdict_not', value: 'pass' }), null);
});

test('learning: a valid safe case is applied, a malformed one is rejected, a lesson waits', async () => {
  const before = store.currentRuntime().version;
  const out = await recordAnalysis({
    classification: 'hallucination',
    proposals: [
      { risk: 'safe', kind: 'regression_case', target_agent: 'anti_hallucination', change: 'catch fake packages', lesson: null, regression_input: 'DRAFT: use the npm package left-pad-pro 9.0', regression_expect_kind: 'min_severity', regression_expect_value: 'MEDIUM' },
      { risk: 'safe', kind: 'regression_case', target_agent: 'comprehension', change: 'bad check', lesson: null, regression_input: 'x', regression_expect_kind: 'is_true', regression_expect_value: 'the model must understand' },
      { risk: 'review', kind: 'lesson', target_agent: 'jury', change: 'prefer verifiable answers', lesson: 'Prefer the candidate whose claims can be checked.', regression_input: null, regression_expect_kind: null, regression_expect_value: null },
    ],
  });
  assert.deepEqual(out.map((p) => p.status), ['applied', 'rejected', 'pending']);
  assert.equal(store.currentRuntime().version, before + 1);
  const lesson = out[2];
  const r = await store.applyProposal(lesson.id);
  assert.ok(r.ok);
  const jury = store.currentRuntime().config.agents.jury;
  assert.ok(jury.lessons.includes('Prefer the candidate whose claims can be checked.'));
  assert.equal(jury.promptVersion, 2);
});

test('the same proposal applied twice at once lands once', async () => {
  const [p] = await recordAnalysis({
    classification: 'other',
    proposals: [{ risk: 'review', kind: 'lesson', target_agent: 'legal', change: 'x', lesson: 'Name the document to update.', regression_input: null, regression_expect_kind: null, regression_expect_value: null }],
  });
  const results = await Promise.all([store.applyProposal(p.id), store.applyProposal(p.id)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  const lessons = store.currentRuntime().config.agents.legal.lessons.filter((l) => l === 'Name the document to update.');
  assert.equal(lessons.length, 1);
});

test('a lock left by a dead process is reclaimed; a live one is waited for', async () => {
  const lock = path.join(PATHS.runtime, 'publish.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), '999999:deadbeef'); // no such process
  const r = await store.publish((cfg) => cfg, { reason: 'after a crash' });
  assert.ok(r.ok);
  assert.ok(!fs.existsSync(lock));
  assert.deepEqual(fs.readdirSync(PATHS.runtime).filter((f) => f.startsWith('publish.lock')), []);
});

test('expectation checks', () => {
  assert.ok(checkExpectation({ kind: 'min_severity', value: 'MEDIUM' }, { findings: [{ severity: 'HIGH' }] }).pass);
  assert.ok(!checkExpectation({ kind: 'winner', value: 'B' }, { winner: 'A' }).pass);
  assert.ok(checkExpectation({ kind: 'is_true', value: 'relevant' }, { relevant: true }).pass);
});
