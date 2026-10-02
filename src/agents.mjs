// The internal agents: comprehension, anti-hallucination, text review, jury, legal and
// learning.
//
// An agent is a role, a prompt, an answer schema and a routing policy, all read from the
// live runtime configuration at the moment of the call. Models come from the same tier
// table and cooldowns as the MCP tools.
//
// Unlike the MCP tools, an agent also moves on after a timeout or a malformed answer:
// Claude is waiting for this result. The time budget is shared across the chain so the
// next family always has time left.
import { buildPacket, resolveWorkdir } from './packet.mjs';
import { buildChain, coolingDown, markFailure, markSuccess, callModel } from './router.mjs';
import { RunError } from './process.mjs';
import { AGENT_SCHEMAS } from './schemas.mjs';
import { extractJson, hasRequiredKeys, completeShape } from './json.mjs';
import { verifyClaims } from './verify.mjs';
import { logEvent } from './events.mjs';
import { appendTrace } from './runtime/store.mjs';

const FALLTHROUGH = new Set(['quota', 'model_unavailable', 'auth', 'spawn_failed', 'disabled', 'empty_response', 'provider_error', 'schema', 'timeout']);
const MAX_INPUT_CHARS = 60000;
const MAX_PACKET_CHARS = 72000;
const MIN_ATTEMPT_MS = 8000;

const FORMAT = 'Answer with the JSON object the schema describes, and nothing else. Write string values in the language of the input. Empty lists are fine answers.';
const REMINDER = '\n\n# REMINDER\nYour previous answer was not the JSON object required. Do not explore, use tools or ask anything: reply now with ONLY the JSON object the schema describes, from the material above.';

export function composePrompt(agent) {
  const lessons = (agent.lessons || []).filter(Boolean);
  return lessons.length ? `${agent.prompt}\n\nLessons from past errors:\n${lessons.map((l) => `- ${l}`).join('\n')}` : agent.prompt;
}

/**
 * Own family (two models: a rate limit on the bigger one often leaves the smaller one
 * open), then each fallback family, then Claude through Antigravity.
 */
export function agentChain(agent) {
  const own = (lane, max) => buildChain(lane, agent.tier, { crossFamily: false, lastResort: false }).slice(0, max);
  const steps = [...own(agent.lane, 2)];
  for (const lane of agent.fallback || []) steps.push(...own(lane, 1));
  steps.push(...buildChain('claude', agent.tier));
  const seen = new Set();
  return steps.filter((s) => !seen.has(s.key) && seen.add(s.key));
}

/**
 * @param {object} o
 * @param {string} o.id         agent id
 * @param {object} o.snapshot   the runtime version for this call, whole
 * @param {string} o.input      what the agent works on
 * @param {string} [o.objective]
 * @param {string} [o.workdir]
 * @param {string[]} [o.paths]
 * @param {string} [o.turnId]
 */
export async function runAgent({ id, snapshot, input, objective, workdir, paths = [], turnId = null }) {
  const started = Date.now();
  const agent = snapshot?.config?.agents?.[id];
  const base = { agent: id, turnId, runtimeVersion: snapshot?.version ?? null };
  if (!agent) return { ok: false, ...base, error: 'unknown_agent', message: `No agent called ${id}.` };
  if (!agent.enabled) {
    appendTrace({ type: 'agent', ...base, status: 'disabled' });
    return { ok: false, ...base, error: 'disabled', message: `${agent.name} is disabled in runtime v${snapshot.version}. Continue without it.` };
  }

  const schema = AGENT_SCHEMAS[agent.output];
  let packet;
  let dir;
  try {
    dir = resolveWorkdir(workdir || process.cwd());
    const body = String(input || '');
    packet = buildPacket({
      role: composePrompt(agent),
      objective: objective || agent.role,
      paths,
      format: FORMAT,
      workdir: dir,
      extra: `# INPUT\n${body.length > MAX_INPUT_CHARS ? `${body.slice(0, MAX_INPUT_CHARS)}\n[input cut at ${MAX_INPUT_CHARS} characters]` : body}`,
      maxChars: MAX_PACKET_CHARS,
    });
  } catch (err) {
    return { ok: false, ...base, error: 'invalid_request', message: err.message };
  }

  const deadline = started + agent.timeoutMs;
  const queue = agentChain(agent).map((s) => ({ s }));
  const attempts = [];
  let forcedLastResort = false;
  let reminded = false;

  for (let i = 0; i < queue.length; i++) {
    const { s, force, remind } = queue[i];
    const cool = force ? null : coolingDown(s.key);
    if (cool) {
      attempts.push({ key: s.key, skipped: true, reason: cool.kind });
      // Everything paused: give the last resort one try anyway. A pause recorded minutes
      // ago should not leave Claude with no answer while there is still time to ask.
      if (i === queue.length - 1 && !forcedLastResort) { queue.push({ s, force: true }); forcedLastResort = true; }
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) { attempts.push({ key: s.key, skipped: true, reason: 'no time left' }); break; }
    const isLast = queue.slice(i + 1).every((n) => !n.force && coolingDown(n.s.key));
    // A hanging model may not eat the time the next family needs.
    const budget = isLast ? remaining : Math.max(MIN_ATTEMPT_MS, Math.round(remaining * 0.6));
    const t0 = Date.now();
    try {
      const result = await callModel(s, { packet: remind ? packet.text + REMINDER : packet.text, workdir: dir, schema, timeoutMs: budget });
      const raw = result.json || extractJson(result.text);
      const json = hasRequiredKeys(raw, schema) ? raw : completeShape(raw, schema);
      if (!json) throw new RunError('schema', 'the answer did not match the agent schema');
      markSuccess(s.key);

      let verification = null;
      if (agent.output === 'hallucination') {
        const withFile = (json.findings || []).filter((f) => f.file);
        if (withFile.length) {
          const v = verifyClaims(withFile, dir);
          verification = `${v.verified}/${v.checked} file claims located`;
        }
      }
      const durationMs = Date.now() - started;
      logEvent({
        kind: 'agent', agent: id, lane: s.lane, model: s.model, tier: s.tier, status: 'ok', durationMs, turnId,
        runtimeVersion: snapshot.version, fallbacks: attempts.length, packetChars: packet.chars,
        inputTokens: result.usage?.inputTokens, cachedInputTokens: result.usage?.cachedInputTokens, outputTokens: result.usage?.outputTokens,
      });
      appendTrace({ type: 'agent', ...base, status: 'ok', lane: s.lane, model: s.model, durationMs, promptVersion: agent.promptVersion });
      return {
        ok: true, ...base, name: agent.name, promptVersion: agent.promptVersion, lane: s.lane, model: s.model, tier: s.tier,
        attempts, durationMs, usage: result.usage || null, verification, result: json,
      };
    } catch (err) {
      const kind = err instanceof RunError ? err.kind : 'internal_error';
      attempts.push({ key: s.key, kind, durationMs: Date.now() - t0, ...(force ? { forced: true } : {}) });
      // A bad answer says something about this answer, not about the model: no cooldown.
      if (kind !== 'schema' && kind !== 'empty_response') markFailure(s.key, kind);
      // Ask the same model again right away, with a reminder. It is the quickest way to an
      // answer: the next family takes longer to start than a reminded retry takes to run.
      if ((kind === 'schema' || kind === 'empty_response') && !reminded && deadline - Date.now() >= 12000) {
        queue.splice(i + 1, 0, { s, force: true, remind: true });
        reminded = true;
      }
      if (!FALLTHROUGH.has(kind)) break;
    }
  }

  logEvent({ kind: 'agent', agent: id, status: 'error', error: 'all_failed', durationMs: Date.now() - started, turnId, runtimeVersion: snapshot.version, fallbacks: attempts.length });
  appendTrace({ type: 'agent', ...base, status: 'error', attempts });
  const tried = attempts.map((a) => `${a.key} ${a.skipped ? `skipped (${a.reason})` : a.kind}`).join(', ');
  return {
    ok: false, ...base, name: agent.name, error: 'all_failed', attempts, durationMs: Date.now() - started,
    message: `${agent.name} could not answer (${tried || 'no model available'}). Continue without it, in proportion to the risk of the task.`,
  };
}
