// Which model answers a call, and what happens when it can't.
//
// Each call runs at a tier (light / standard / deep). The chain for a call is: its own
// family at that tier, the same family one tier down, the other families at that tier
// (if crossFamily fallback is on), and Claude through Antigravity last. A model that
// fails on quota, login or availability sits out for a while, recorded on disk so
// every process skips it at once instead of paying the same failure again.
import fs from 'node:fs';
import path from 'node:path';
import { config, PATHS } from './config.mjs';
import { callCodex, callAntigravity } from './providers.mjs';
import { RunError } from './process.mjs';

export const TIERS = ['light', 'standard', 'deep'];
export const LANES = ['codex', 'gemini', 'oss', 'claude'];

// Failures that move a call to the next model. A timeout stops it: trying elsewhere
// would double the wait. (Internal agents use their own, wider set.)
export const FALLTHROUGH = new Set(['quota', 'model_unavailable', 'auth', 'spawn_failed', 'empty_response', 'provider_error']);

const COOLDOWN_MS = {
  quota: 20 * 60_000,
  model_unavailable: 6 * 3600_000,
  auth: 10 * 60_000,
  spawn_failed: 10 * 60_000,
  empty_response: 3 * 60_000,
  provider_error: 2 * 60_000,
  timeout: 5 * 60_000,
};

const HEALTH_FILE = path.join(PATHS.state, 'provider-health.json');

function readHealth() {
  try { return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeHealth(h) {
  try {
    fs.mkdirSync(PATHS.state, { recursive: true });
    const now = Date.now();
    for (const [k, v] of Object.entries(h)) if (!v || v.until < now) delete h[k];
    const tmp = `${HEALTH_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(h, null, 1), 'utf8');
    fs.renameSync(tmp, HEALTH_FILE); // atomic: other processes never read half a file
  } catch { /* losing this costs one failed attempt, nothing more */ }
}

export function coolingDown(key) {
  const e = readHealth()[key];
  return e && e.until > Date.now() ? e : null;
}

export function markFailure(key, kind) {
  const ms = COOLDOWN_MS[kind];
  if (!ms) return;
  const h = readHealth();
  h[key] = { kind, until: Date.now() + ms };
  writeHealth(h);
}

export function markSuccess(key) {
  const h = readHealth();
  if (h[key]) { delete h[key]; writeHealth(h); }
}

export function pausedModels() {
  const now = Date.now();
  return Object.entries(readHealth())
    .filter(([, v]) => v?.until > now)
    .map(([key, v]) => ({ key, kind: v.kind, minutesLeft: Math.ceil((v.until - now) / 60000) }));
}

// ---------------------------------------------------------------------- tiers

const DEEP_WORDS = /\b(secur|auth|oauth|jwt|token|session|password|crypt|payment|stripe|invoice|billing|money|race|concurren|deadlock|lock|migration|data loss|corrupt|production|deploy|permission|privilege|injection|xss|csrf|ssrf|sandbox|rce)/i;
const LIGHT_WORDS = /\b(regex|typo|rename|naming|one.?liner|quick|sanity|syntax|format|small|trivial|simple)/i;

/** Small and ordinary goes light; money, identity, concurrency, production go deep. */
export function autoTier({ subject = '', diff = '', paths = [], packetChars = 0 }) {
  const diffLines = diff ? diff.split('\n').length : 0;
  if (DEEP_WORDS.test(subject) || diffLines > 400 || paths.length > 8) return 'deep';
  if (packetChars < 5000 && diffLines <= 60 && paths.length <= 2) return 'light';
  if (LIGHT_WORDS.test(subject) && diffLines <= 120 && paths.length <= 3) return 'light';
  return 'standard';
}

export function resolveTier(requested, toolDefault, info) {
  if (TIERS.includes(requested)) return requested;
  if (requested === 'auto' || !toolDefault || toolDefault === 'auto') return autoTier(info);
  return toolDefault;
}

function laneOn(lane) {
  return config.lanes?.[lane]?.enabled !== false;
}

export function step(lane, tier) {
  if (!laneOn(lane)) return null;
  const timeoutMs = config.tiers?.[tier]?.timeoutMs ?? 300000;
  const spec = lane === 'claude' ? config.lanes.claude : config.tiers?.[tier]?.[lane];
  if (!spec?.model) return null;
  return { lane, tier, model: spec.model, effort: spec.effort || null, timeoutMs, key: `${lane}:${spec.model}` };
}

const OTHERS = { codex: ['gemini', 'oss'], gemini: ['oss', 'codex'], oss: ['gemini', 'codex'], claude: [] };

/**
 * Own lane, one tier down (from deep, the standard model is a fair stand-in), then the
 * other families, then Claude. A council passes crossFamily=false so its voices stay
 * distinct families.
 */
export function buildChain(lane, tier, { crossFamily = config.fallback?.crossFamily !== false, lastResort = true } = {}) {
  const below = TIERS[TIERS.indexOf(tier) - 1];
  const order = [[lane, tier]];
  if (below) order.push([lane, below]);
  if (crossFamily) for (const other of OTHERS[lane] || []) order.push([other, tier]);
  if (lastResort && lane !== 'claude') order.push(['claude', tier]);

  const seen = new Set();
  const chain = [];
  for (const [l, t] of order) {
    const s = step(l, t);
    if (s && !seen.has(s.key)) { seen.add(s.key); chain.push(s); }
  }
  return chain;
}

export function callModel(s, args) {
  const fn = s.lane === 'codex' ? callCodex : callAntigravity;
  return fn({ ...args, model: s.model, effort: s.effort });
}

/**
 * Walk the chain until a model answers.
 * @returns {Promise<{result, served, attempts}>}
 * @throws the last RunError, with `.attempts`, when nothing answered
 */
export async function callWithFallback({ lane, tier, packet, workdir, schema, timeoutMs, model, effort, crossFamily, onAttempt }) {
  let chain = buildChain(lane, tier, { crossFamily });
  if (model) {
    const pinned = { lane, tier, model, effort: effort || null, timeoutMs: config.tiers?.[tier]?.timeoutMs ?? 300000, key: `${lane}:${model}` };
    chain = [pinned, ...chain.filter((s) => s.key !== pinned.key)];
  } else if (effort && chain[0]?.lane === lane) {
    chain[0] = { ...chain[0], effort };
  }

  const attempts = [];
  let lastErr = new RunError('disabled', 'no model is enabled for this call');
  for (const s of chain) {
    const cool = coolingDown(s.key);
    if (cool) { attempts.push({ ...s, skipped: true, reason: cool.kind }); continue; }
    onAttempt?.(s);
    const t0 = Date.now();
    try {
      const result = await callModel(s, { packet, workdir, schema, timeoutMs: timeoutMs || s.timeoutMs });
      markSuccess(s.key);
      attempts.push({ ...s, ok: true, durationMs: Date.now() - t0 });
      return { result, served: s, attempts };
    } catch (err) {
      const kind = err instanceof RunError ? err.kind : 'internal_error';
      attempts.push({ ...s, ok: false, kind, durationMs: Date.now() - t0 });
      lastErr = err;
      if (!FALLTHROUGH.has(kind)) break;
      markFailure(s.key, kind);
    }
  }
  lastErr.attempts = attempts;
  throw lastErr;
}

/** "gpt-6-astra failed (quota); gemini-3.1-pro-high skipped (paused)" */
export function describeAttempts(attempts) {
  const failed = attempts.filter((a) => !a.ok);
  if (!failed.length) return null;
  return failed.map((a) => `${a.model} ${a.skipped ? `skipped (paused after ${a.reason})` : `failed (${a.kind})`}`).join('; ');
}
