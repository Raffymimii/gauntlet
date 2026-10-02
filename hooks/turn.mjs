#!/usr/bin/env node
// UserPromptSubmit / Stop hook: the per-message part of tandem.
//
// It runs as a fresh process before Claude reads each message, so this is where a chat
// that has been open for days picks up a runtime version published a minute ago. On each
// message it:
//   1. reads the current runtime version;
//   2. injects the policy and agent list when this chat hasn't seen that version yet;
//   3. routes cheaply (trivial / legal keywords / error report / long multi-part request)
//      and runs the comprehension agent only on long multi-part requests;
//   4. opens a learning event when the user reports an error.
//
// It never blocks a message. Any failure means "no extra context this turn".
// Register it with a timeout of at least 60 seconds (tandem init does).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARD_LIMIT_MS = 55_000;
// Last resort only. process.exit() right after a fetch can crash Node on Windows, so the
// normal path ends by setting exitCode instead.
setTimeout(() => process.exit(0), HARD_LIMIT_MS).unref();

// Read stdin asynchronously, so the timer above can always fire even if the input never
// ends; Claude Code closes it right away in practice.
function readInput(limitMs = 5000) {
  return new Promise((resolve) => {
    let data = '';
    const done = () => {
      process.stdin.destroy();
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    };
    setTimeout(done, limitMs).unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { data += d; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

const input = await readInput();
const event = input.hook_event_name;

function emit(text) {
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
}

const lib = (f) => import(pathToFileURL(path.join(ROOT, 'src', f)).href);

async function main() {
  const store = await lib('runtime/store.mjs');
  const key = store.sessionKey(input.session_id);
  const sess = store.readSession(key) || {};

  if (event === 'Stop') {
    if (sess.openTurn) {
      store.appendTrace({ type: 'turn', state: 'end', turnId: sess.openTurn, sessionKey: key, durationMs: Date.now() - (sess.turnStartedAt || Date.now()) });
      // Close only the turn this Stop read; a newer prompt may have opened another.
      const latest = store.readSession(key);
      if (latest?.openTurn === sess.openTurn) store.writeSession(key, { ...latest, openTurn: null, turnStartedAt: null });
    }
    return;
  }
  if (event !== 'UserPromptSubmit') return;

  const snap = store.currentRuntime();
  const cfg = snap.config;
  const R = cfg.routing || {};
  const prompt = String(input.prompt || '');
  const lower = prompt.toLowerCase();
  const turnId = store.newId('t');
  const stale = sess.version !== snap.version;

  // Cheap signals, no model involved.
  const requirements = prompt.split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length;
  const codeish = /```|\b[\w-]+\.(ts|tsx|js|mjs|cjs|py|java|kt|go|rs|json|ya?ml|sql|sh|ps1|php|css|html)\b|[\\/][\w.-]+[\\/]/.test(prompt);
  const legal = cfg.agents.legal?.enabled ? (R.legalKeywords || []).filter((k) => lower.includes(k.toLowerCase())) : [];
  const feedback = (R.feedbackPatterns || []).some((k) => lower.includes(k.toLowerCase()));
  const trivial = prompt.length <= (R.trivialMaxChars ?? 140) && !codeish && !feedback && !legal.length;

  const C = R.comprehension || {};
  const wantComprehension = cfg.agents.comprehension?.enabled && C.mode !== 'off' && !trivial
    && (C.mode === 'always' || prompt.length >= (C.minChars ?? 700) || requirements >= (C.minRequirements ?? 4));

  let comp = null;
  if (wantComprehension) {
    const { runAgent } = await lib('agents.mjs');
    const limit = Math.min(C.timeoutMs ?? 40000, HARD_LIMIT_MS - 10000);
    comp = await Promise.race([
      runAgent({ id: 'comprehension', snapshot: snap, input: prompt, objective: 'Structured reading of the user message', workdir: input.cwd || process.cwd(), turnId }),
      new Promise((r) => setTimeout(() => r({ ok: false, error: 'timeout' }), limit).unref()),
    ]);
  }

  let learningEvent = null;
  if (feedback) {
    learningEvent = store.saveLearningEvent({ sessionKey: key, turnId, previousTurnId: sess.lastTurnId || null, runtimeVersion: snap.version, feedback: prompt.slice(0, 16000) });
  }

  const agentCli = `node "${path.join(ROOT, 'bin', 'tandem.mjs')}" agent`;
  const lines = [`[tandem runtime v${snap.version}, turn ${turnId}]`];
  if (stale) {
    lines.push(sess.version == null
      ? 'First turn with the tandem runtime in this chat. The rules below apply from now on.'
      : `Runtime updated from v${sess.version} to v${snap.version}. The rules below replace the earlier ones from this turn on; the conversation so far stays valid.`);
    lines.push(`Policy: ${cfg.policy.summary}`);
    for (const r of cfg.policy.rules) lines.push(`- ${r}`);
    lines.push('Internal agents (read-only advisers; you call them, the user never does):');
    for (const [id, a] of Object.entries(cfg.agents)) {
      lines.push(`- ${id}${a.enabled ? '' : ' [disabled]'}: ${a.role} [${a.lane}/${a.tier}, fallback ${a.fallback.join(', ') || 'none'}]`);
    }
    lines.push(`Run one with: ${agentCli} <id> --turn ${turnId} --workdir "<project>" [--paths a,b] --objective "<one line>" --input-file <file>. JSON on stdout. Exit code 2 means unavailable: carry on without it.`);
  } else {
    lines.push(`Runtime unchanged (v${snap.version}); the rules you already have still apply.`);
  }
  if (trivial) lines.push('Routing: simple message, no internal agents needed.');

  if (comp?.ok) {
    const j = comp.result;
    const list = (label, arr) => (arr?.length ? `- ${label}: ${arr.join(' | ')}` : null);
    lines.push(`Comprehension (${comp.model}), advisory; the user's message remains the source:`);
    lines.push(...[
      `- Intent: ${j.interpreted_intent}`,
      `- Main goal: ${j.primary_goal}`,
      list('Other goals', j.secondary_goals),
      list('Required output', j.required_output),
      list('Constraints', j.constraints),
      list('Do NOT', j.must_not_do),
      list('Ambiguities', j.ambiguities),
      list('Missing information', j.missing_information),
      list('Risky assumptions', j.unsafe_assumptions),
      list('Suggested plan', j.recommended_execution_plan),
    ].filter(Boolean));
  } else if (comp) {
    lines.push(`Comprehension unavailable (${comp.error}); work from the original message.`);
  }
  if (legal.length) lines.push(`Possible legal impact (${legal.slice(0, 4).join(', ')}): if the work touches personal data, terms, licences or payments, consult the legal agent.`);
  if (learningEvent) lines.push(`The user is reporting an error. Learning event ${learningEvent} is open. Answer the user first, then run: ${agentCli} learning --event ${learningEvent} --input-file <file with what went wrong and your earlier output>.`);

  emit(lines.join('\n'));

  const now = Date.now();
  store.writeSession(key, { ...sess, version: snap.version, lastTurnId: turnId, openTurn: turnId, turnStartedAt: now, turns: (sess.turns || 0) + 1 });
  store.appendTrace({
    type: 'turn', state: 'start', turnId, sessionKey: key, runtimeVersion: snap.version, previousVersion: sess.version ?? null,
    refreshed: stale, trivial, comprehension: comp ? (comp.ok ? comp.model : comp.error) : null, learningEvent,
  });
}

try {
  await main();
} catch (err) {
  if (event === 'UserPromptSubmit') emit(`[tandem: pre-turn hook error (${String(err?.message || err).slice(0, 160)}). Continuing without runtime context.]`);
}
process.exitCode = 0;
