import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildChain, autoTier, resolveTier, markFailure, coolingDown, markSuccess } = await import('../src/router.mjs');
const { agentChain } = await import('../src/agents.mjs');

test('chain: own family, one tier down, other families, Claude last', () => {
  const lanes = buildChain('codex', 'deep').map((s) => `${s.lane}:${s.tier}`);
  assert.deepEqual(lanes, ['codex:deep', 'codex:standard', 'gemini:deep', 'oss:deep', 'claude:deep']);
});

test('a council chain stays in its family', () => {
  assert.deepEqual(buildChain('gemini', 'standard', { crossFamily: false }).map((s) => s.lane), ['gemini', 'gemini', 'claude']);
});

test('agent chain: own family, then its fallback family, then Claude, never Claude early', () => {
  const chain = agentChain({ lane: 'codex', tier: 'standard', fallback: ['gemini'] }).map((s) => s.lane);
  assert.deepEqual(chain, ['codex', 'codex', 'gemini', 'claude']);
  assert.equal(chain.indexOf('claude'), chain.length - 1);
});

test('auto tier: money and security go deep, tiny questions go light', () => {
  assert.equal(autoTier({ subject: 'check the stripe payment webhook' }), 'deep');
  assert.equal(autoTier({ subject: 'is this regex right', packetChars: 900 }), 'light');
  assert.equal(resolveTier('standard', 'deep', {}), 'standard');
});

test('cooldowns are recorded and cleared', () => {
  markFailure('codex:test-model', 'quota');
  assert.equal(coolingDown('codex:test-model')?.kind, 'quota');
  markSuccess('codex:test-model');
  assert.equal(coolingDown('codex:test-model'), null);
});
