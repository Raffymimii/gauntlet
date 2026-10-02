// The live runtime configuration: policy, routing, agents and regression cases, kept as
// numbered versions under ~/.gauntlet/runtime/versions.
//
// Claude Code reads CLAUDE.md and starts MCP servers when a chat opens, then never again.
// The pre-turn hook is a fresh process on every message, and it reads the highest version
// here, so a change published now applies to chats that have been open for days, from
// their next message, without losing any history.
//
// Versions only go up. A rollback publishes a copy of an older version as a new one, so the
// history always says what was in force when.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, PACKAGE_ROOT } from '../config.mjs';
import { agentPrompt } from '../prompts.mjs';
import { validateRuntime } from './validate.mjs';

const DIR = PATHS.runtime;
const VERSIONS = path.join(DIR, 'versions');
const LOCK = path.join(DIR, 'publish.lock');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Version 0: the package defaults with the prompts from prompts/agents. Never written. */
export function seedConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'runtime', 'defaults.json'), 'utf8'));
  for (const [id, a] of Object.entries(cfg.agents)) a.prompt = agentPrompt(id);
  return cfg;
}

function versionNumbers() {
  try {
    return fs.readdirSync(VERSIONS)
      .map((f) => f.match(/^v(\d+)\.json$/)?.[1])
      .filter(Boolean).map(Number).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function readVersion(n) {
  if (n === 0) return { version: 0, publishedAt: null, reason: 'package defaults', config: seedConfig() };
  return readJson(path.join(VERSIONS, `v${n}.json`));
}

/**
 * The configuration in force: the highest version that validates. A broken file is
 * skipped (and reported), never used.
 */
export function currentRuntime() {
  const nums = versionNumbers();
  const skipped = [];
  for (let i = nums.length - 1; i >= 0; i--) {
    const snap = readJson(path.join(VERSIONS, `v${nums[i]}.json`));
    if (snap?.version === nums[i] && snap.config && validateRuntime(snap.config).ok) return { ...snap, skipped };
    skipped.push(nums[i]);
  }
  return { ...readVersion(0), skipped };
}

export function listVersions() {
  return versionNumbers().map((n) => {
    const s = readJson(path.join(VERSIONS, `v${n}.json`));
    return { version: n, publishedAt: s?.publishedAt ?? null, reason: s?.reason ?? null, rollbackOf: s?.rollbackOf ?? null, valid: Boolean(s?.config && validateRuntime(s.config).ok) };
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * Takes an abandoned lock out of the way. The rename is atomic, so of two processes
 * reclaiming the same lock only one moves it; the other may instead move a lock that was
 * just taken by a live process, which is why the owner is checked after the move and the
 * lock put back if it isn't the dead one.
 */
function reclaim(deadOwner) {
  const aside = `${LOCK}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try { fs.renameSync(LOCK, aside); } catch { return; }
  let moved = '';
  try { moved = fs.readFileSync(path.join(aside, 'owner'), 'utf8'); } catch { /* none */ }
  if (moved && moved !== deadOwner) {
    try { fs.renameSync(aside, LOCK); return; } catch { /* a third process took the lock meanwhile */ }
  }
  fs.rmSync(aside, { recursive: true, force: true });
}

/**
 * A directory lock (mkdir is atomic everywhere) with an owner file inside. A lock is taken
 * over only when its owner process is gone, never just because it is old, and the owner
 * only removes a lock that is still its own.
 */
async function withLock(fn) {
  fs.mkdirSync(DIR, { recursive: true });
  const me = `${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
  const ownerFile = path.join(LOCK, 'owner');
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(ownerFile, me, 'utf8');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let owner = '';
      try { owner = fs.readFileSync(ownerFile, 'utf8'); } catch { /* being created, or abandoned mid-create */ }
      const pid = Number(owner.split(':')[0]);
      const abandoned = owner ? !alive(pid) : Date.now() - (fs.statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 5000;
      if (abandoned) {
        reclaim(owner);
        continue;
      }
      if (Date.now() > deadline) throw new Error('another publish is in progress');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    // Move the lock aside before deleting it, and only if it is still ours: a live lock is
    // never reclaimed by others, so it can't have changed hands while we held it.
    const aside = `${LOCK}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      if (fs.readFileSync(ownerFile, 'utf8') === me) {
        fs.renameSync(LOCK, aside);
        fs.rmSync(aside, { recursive: true, force: true });
      }
    } catch { /* already gone */ }
  }
}

/**
 * `change` is either a whole configuration or a function that turns the current one into
 * the next. The function form runs inside the lock, so two edits published at the same
 * moment cannot overwrite each other.
 * @returns {Promise<{ok: true, version: number} | {ok: false, errors: string[]}>}
 */
export function publish(change, { reason, rollbackOf = null, onPublished = null } = {}) {
  return withLock(() => {
    let config;
    try {
      config = typeof change === 'function' ? change(structuredClone(currentRuntime().config)) : change;
    } catch (err) {
      return { ok: false, errors: [err.message] };
    }
    const v = validateRuntime(config);
    if (!v.ok) return { ok: false, errors: v.errors };
    const next = (versionNumbers().at(-1) ?? 0) + 1;
    writeJsonAtomic(path.join(VERSIONS, `v${next}.json`), {
      version: next, publishedAt: new Date().toISOString(), reason: reason || null, rollbackOf, config,
    });
    onPublished?.(next); // still inside the lock
    return { ok: true, version: next };
  });
}

export function rollback(to, reason) {
  const old = readVersion(to);
  if (!old?.config) return Promise.resolve({ ok: false, errors: [`version ${to} does not exist`] });
  return publish(old.config, { reason: reason || `rollback to v${to}`, rollbackOf: to });
}

// ------------------------------------------------------------- sessions, traces

export function sessionKey(id) {
  return crypto.createHash('sha256').update(String(id || 'unknown')).digest('hex').slice(0, 12);
}

export function readSession(key) {
  return readJson(path.join(DIR, 'sessions', `${key}.json`));
}

export function writeSession(key, data) {
  try { writeJsonAtomic(path.join(DIR, 'sessions', `${key}.json`), data); } catch { /* best effort */ }
}

export function appendTrace(record) {
  try {
    const dir = path.join(DIR, 'traces');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ ts: Date.now(), ...record }) + '\n', 'utf8');
  } catch { /* traces are evidence, not a dependency */ }
}

export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

// --------------------------------------------------------------------- learning

export function saveLearningEvent(event) {
  const id = newId('e');
  writeJsonAtomic(path.join(DIR, 'learning', `${id}.json`), { id, createdAt: new Date().toISOString(), ...event });
  return id;
}

export function readLearningEvent(id) {
  if (!/^e[a-z0-9]+$/.test(id)) return null;
  return readJson(path.join(DIR, 'learning', `${id}.json`));
}

export function saveProposal(p) {
  const id = newId('p');
  writeJsonAtomic(path.join(DIR, 'proposals', `${id}.json`), { id, createdAt: new Date().toISOString(), status: 'pending', ...p });
  return id;
}

export function readProposal(id) {
  if (!/^p[a-z0-9]+$/.test(id)) return null;
  return readJson(path.join(DIR, 'proposals', `${id}.json`));
}

export function listProposals() {
  const dir = path.join(DIR, 'proposals');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  return files.map((f) => readJson(path.join(dir, f))).filter(Boolean);
}

export function setProposalStatus(id, status, extra = {}) {
  const p = readProposal(id);
  if (!p) return null;
  const next = { ...p, status, decidedAt: new Date().toISOString(), ...extra };
  writeJsonAtomic(path.join(DIR, 'proposals', `${id}.json`), next);
  return next;
}

/**
 * Applies one proposal to the current configuration and publishes the result. Only
 * lessons and regression cases can be applied mechanically; prompt and routing changes
 * are described in prose and need a person to edit the configuration.
 */
export async function applyProposal(id, { automatic = false } = {}) {
  const p = readProposal(id);
  if (!p || p.status !== 'pending') return { ok: false, errors: ['no pending proposal with that id'] };
  if (p.kind !== 'lesson' && p.kind !== 'regression_case') {
    return { ok: false, errors: [`a ${p.kind} has to be applied by hand: edit the configuration and run gauntlet runtime publish`] };
  }

  const r = await publish((cfg) => {
    // Checked again under the lock: another process may have applied it, or switched
    // automatic application off, since this one first looked.
    if (readProposal(id)?.status !== 'pending') throw new Error('the proposal is no longer pending');
    if (automatic && cfg.routing?.autoApply === 'none') throw new Error('automatic application is switched off');
    const target = p.target_agent && cfg.agents[p.target_agent];
    if (p.kind === 'lesson') {
      if (!target || !p.lesson) throw new Error('a lesson needs a target agent and the lesson text');
      target.lessons = [...target.lessons, p.lesson.trim()];
      target.promptVersion += 1;
    } else {
      if (!target || !p.regression_input) throw new Error('a regression case needs a target agent and an input');
      cfg.regressions = [...cfg.regressions, {
        id: `learned-${id}`,
        agent: p.target_agent,
        description: p.change,
        input: p.regression_input,
        expect: { kind: p.regression_expect_kind, value: p.regression_expect_value },
      }];
    }
    return cfg;
  }, {
    reason: `${automatic ? 'auto-applied' : 'applied'} proposal ${id}: ${p.change}`,
    onPublished: (version) => setProposalStatus(id, 'applied', { version, automatic }),
  });
  return r;
}
