// One specialist consultation, start to finish: packet, tier, cache, fallback chain,
// claim verification, memory and the event log. Returns data rather than an MCP result,
// so the council can combine several.
import { config } from './config.mjs';
import { buildPacket, resolveWorkdir, PacketError } from './packet.mjs';
import { DEPTH_VAR } from './providers.mjs';
import { RunError } from './process.mjs';
import { resolveTier, callWithFallback, describeAttempts, buildChain } from './router.mjs';
import { REVIEW_SCHEMA, ANALYSIS_SCHEMA, claimsOf } from './schemas.mjs';
import { verifyClaims, verificationLine } from './verify.mjs';
import { remember } from './findings.mjs';
import { renderReport } from './report.mjs';
import { cacheGet, cacheSet, cacheKey } from './cache.mjs';
import { logEvent } from './events.mjs';

export const NESTED = process.env[DEPTH_VAR] === '1';

export class Limiter {
  constructor(max) { this.max = Math.max(1, max | 0); this.active = 0; this.queue = []; }
  async run(fn) {
    if (this.active >= this.max) await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const limiter = new Limiter(config.limits.maxConcurrent);
export const limiterState = () => ({ running: limiter.active, queued: limiter.queue.length });

export function schemaFor(tool) {
  return tool === 'gemini_analyze' ? ANALYSIS_SCHEMA : REVIEW_SCHEMA;
}

export function preparePacket({ role, format, args, extra = '' }) {
  const workdir = resolveWorkdir(args.workdir);
  const packet = buildPacket({
    role, format, workdir, extra,
    objective: args.objective,
    constraints: args.constraints || [],
    paths: args.paths || [],
    diff: args.diff || '',
    checks: args.checks || [],
  });
  return { workdir, packet };
}

/**
 * @param {object} o
 * @param {string} o.tool        tool name, for the cache, the schema and the log
 * @param {string} o.lane        codex | gemini | oss
 * @param {string} o.defaultTier the tool's default when the caller says nothing
 * @param {string} o.role        from prompts/specialists
 * @param {string} o.format      from prompts/specialists
 * @param {object} o.args        the MCP tool arguments
 * @param {boolean} [o.crossFamily] false for council voices
 */
export async function consult({ tool, lane, defaultTier, role, format, args, crossFamily, extra = '' }) {
  if (NESTED) {
    return { ok: false, lane, message: 'Refused: this server is running inside a specialist, and specialists may not call further specialists.' };
  }

  let workdir;
  let packet;
  try {
    ({ workdir, packet } = preparePacket({ role, format, args, extra }));
  } catch (err) {
    return { ok: false, lane, message: `Request rejected before anything was sent: ${err instanceof PacketError ? err.message : err.message}` };
  }

  const tier = resolveTier(args.tier, defaultTier, {
    subject: [args.objective, ...(args.constraints || []), ...(args.checks || [])].join(' '),
    diff: args.diff || '', paths: args.paths || [], packetChars: packet.chars,
  });
  const schema = schemaFor(tool);
  const key = cacheKey({
    tool, lane, tier, model: args.model || '', effort: args.effort || '', hash: packet.contentHash,
    crossFamily: crossFamily ?? null, chain: buildChain(lane, tier, { crossFamily }).map((s) => s.key),
  });
  const base = { kind: 'specialist', tool, tier, packetChars: packet.chars, files: packet.files.length };

  if (!args.noCache) {
    const hit = cacheGet(key);
    if (hit) {
      const planned = buildChain(lane, tier, { crossFamily })[0];
      logEvent({ ...base, lane, model: planned?.model, status: 'ok', cached: true, durationMs: 0 });
      return { ok: true, lane: hit.lane || lane, model: hit.model || planned?.model, tier, body: hit.body, json: hit.json, cached: true, packet };
    }
  }

  try {
    const { result, served, attempts } = await limiter.run(() => callWithFallback({
      lane, tier, crossFamily, schema, workdir,
      packet: packet.text,
      timeoutMs: args.timeoutMs,
      model: args.model,
      effort: args.effort,
    }));

    let body = result.text;
    let verification = null;
    let v = null;
    if (result.json) {
      v = verifyClaims(claimsOf(result.json), workdir);
      const memory = remember({ workdir, lane: served.lane, tool, claims: v.claims });
      body = renderReport(result.json, v, memory);
      verification = verificationLine(v);
    }
    cacheSet(key, { body, json: result.json, lane: served.lane, model: served.model });
    logEvent({
      ...base, lane: served.lane, model: served.model, status: 'ok', cached: false, durationMs: result.durationMs,
      fallbacks: attempts.length - 1, checked: v?.checked, verified: v?.verified,
      inputTokens: result.usage?.inputTokens, cachedInputTokens: result.usage?.cachedInputTokens, outputTokens: result.usage?.outputTokens,
    });
    return {
      ok: true, lane: served.lane, model: served.model, tier, body, json: result.json, cached: false, packet,
      durationMs: result.durationMs, truncated: result.truncated || packet.truncated,
      verification, usage: result.usage, fallback: describeAttempts(attempts),
    };
  } catch (err) {
    const kind = err instanceof RunError ? err.kind : 'internal_error';
    const attempts = err.attempts || [];
    logEvent({ ...base, lane, status: 'error', error: kind, fallbacks: Math.max(0, attempts.length - 1) });
    const tried = describeAttempts(attempts);
    const message = attempts.length && attempts.every((a) => a.skipped)
      ? `Every model for this call is paused after recent failures (${tried}). Continue without this opinion, or use the sonnet-reviewer subagent.`
      : `${failureText(lane, kind, err)}${tried ? `\n\nTried: ${tried}` : ''}`;
    return { ok: false, lane, kind, message };
  }
}

function failureText(lane, kind, err) {
  const tail = err?.detail?.stderrTail ? `\n\nCLI output (tail): ${err.detail.stderrTail}` : '';
  const text = {
    timeout: `${lane} ran out of time and was stopped. Narrow the packet, use a lighter tier, or continue without this opinion.`,
    quota: `${lane} and its fallbacks are out of subscription quota right now. Continue without this opinion, or use the sonnet-reviewer subagent.`,
    auth: `${lane} is not signed in. Run tandem_status, ask the user to sign in, and continue without it meanwhile.`,
    spawn_failed: `${lane} could not be started (${err.message}). Continue without it.`,
    disabled: 'No model is enabled for this call in the tandem config.',
    empty_response: `${lane} returned no usable answer. Continue without it.`,
    model_unavailable: `${lane}: the configured model is not available to this CLI. Update the tier table in ~/.tandem/config.json.`,
    provider_error: `${lane} failed: ${err.message}.`,
  }[kind] || `${lane} failed unexpectedly: ${err.message}.`;
  return `${text} Nothing was written.${tail}`;
}

/** The one-line header Claude sees above each answer. */
export function header(r) {
  const notes = [`tier ${r.tier}`];
  if (r.cached) notes.push('from cache (inputs unchanged)');
  if (r.durationMs) notes.push(`${(r.durationMs / 1000).toFixed(1)}s`);
  if (r.packet?.chars) notes.push(`packet ${r.packet.chars} chars`);
  if (r.usage?.inputTokens) notes.push(`${r.usage.inputTokens} tokens in / ${r.usage.outputTokens ?? '?'} out`);
  if (r.verification) notes.push(r.verification);
  if (r.fallback) notes.push(`FALLBACK: ${r.fallback}`);
  if (r.truncated) notes.push('TRUNCATED at the configured limit');
  if (r.packet?.skipped?.length) notes.push(`not sent: ${r.packet.skipped.join('; ')}`);
  return `[${r.lane}${r.model ? ` / ${r.model}` : ''}, advisory and read-only: ${notes.join(', ')}]`;
}
