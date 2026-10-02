import { TMP } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { withTandemHooks, withoutTandemHooks } = await import('../src/install.mjs');

function hook(script, input) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', script)], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, TANDEM_HOME: path.join(TMP, 'hookhome') },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('readonly guard: reads pass, writes and tricks are denied', () => {
  const run = (command) => hook('readonly-guard.mjs', { tool_name: 'Bash', tool_input: { command } }).code;
  assert.equal(run('git status && npm test'), 0);
  assert.equal(run('npm test 2>&1 | tail -20'), 0);
  assert.equal(run('rm -rf build'), 2);
  assert.equal(run('cat a > b'), 2);
  assert.equal(run('git push'), 2);
  assert.equal(run('node -e "require(\'fs\').rmSync(\'x\')"'), 2);
  assert.equal(run('ls & touch PWNED'), 2);
  assert.equal(run('"node" -e "1"'), 2);
  assert.equal(run('awk \'BEGIN {system("touch x")}\''), 2);
  assert.equal(run('sort -o out.txt in.txt'), 2);
  assert.equal(run('git diff --output=x.patch'), 2);
  assert.equal(hook('readonly-guard.mjs', { tool_name: 'Write', tool_input: {} }).code, 2);
});

test('review gate: a push after unreviewed edits is denied, a review clears it', () => {
  const s = { session_id: 'gate-test' };
  const push = () => hook('review-gate.mjs', { ...s, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }).out;
  assert.equal(push(), '');
  hook('review-gate.mjs', { ...s, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/p/src/app.ts' } });
  assert.match(push(), /"permissionDecision":"deny"/);
  assert.equal(hook('review-gate.mjs', { ...s, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push # review-skip: typo' } }).out, '');
  hook('review-gate.mjs', { ...s, hook_event_name: 'PostToolUse', tool_name: 'mcp__tandem__quick_check', tool_input: {} });
  assert.equal(push(), '');
});

test('turn hook: injects the runtime on the first message and stays quiet after', () => {
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: TMP, prompt: 'hi' };
  const first = JSON.parse(hook('turn.mjs', input).out);
  assert.match(first.hookSpecificOutput.additionalContext, /First turn with the tandem runtime/);
  assert.match(first.hookSpecificOutput.additionalContext, /Policy:/);
  const second = JSON.parse(hook('turn.mjs', input).out);
  assert.match(second.hookSpecificOutput.additionalContext, /Runtime unchanged/);
  assert.doesNotMatch(second.hookSpecificOutput.additionalContext, /Policy:/);
});

test('turn hook: an error report opens a learning event', () => {
  const out = JSON.parse(hook('turn.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's2', cwd: TMP, prompt: "that's wrong, the function doesn't exist" }).out);
  assert.match(out.hookSpecificOutput.additionalContext, /Learning event e[a-z0-9]+ is open/);
});

test('installer merges hooks without touching the user\'s own, and removes only its own', () => {
  const mine = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-hook.sh' }] }] }, theme: 'dark' };
  const merged = withTandemHooks(mine, ['turn', 'review-gate']);
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.ok(merged.hooks.UserPromptSubmit[0].hooks[0].timeout >= 60);
  const twice = withTandemHooks(merged, ['turn', 'review-gate']);
  assert.deepEqual(twice, merged, 'installing twice changes nothing');
  assert.deepEqual(withoutTandemHooks(twice), mine);
});
