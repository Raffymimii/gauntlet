// Adapters for the two CLIs that do the actual work. Both run non-interactively,
// read-only, inside one working directory, on the user's own subscription login.
//
//   codex   OpenAI Codex CLI, signed in with ChatGPT          -> lane "codex"
//   agy     Google Antigravity CLI, signed in with Google     -> lanes "gemini", "oss", "claude"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { run, RunError, resolveCommand } from './process.mjs';
import { extractJson } from './json.mjs';

// Set on every child. A gauntlet server started inside one refuses to serve, so a
// specialist can never call further specialists.
export const DEPTH_VAR = 'GAUNTLET_DEPTH';

function tmpFile(prefix, ext) {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(8).toString('hex')}${ext}`);
}

function writeSchema(schema, prefix) {
  if (!schema) return null;
  const file = tmpFile(prefix, '.json');
  fs.writeFileSync(file, JSON.stringify(schema), 'utf8');
  return file;
}

function unlinkQuietly(file) {
  if (file) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
}

// --------------------------------------------------------------------- codex

export async function callCodex({ packet, workdir, model, effort, timeoutMs, schema }) {
  const p = config.providers.codex;
  const lastMessage = tmpFile('gauntlet-codex', '.txt');
  const schemaFile = writeSchema(schema, 'gauntlet-codex-schema');
  const args = [
    'exec',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--ignore-user-config', // the user's own pins, skills and hooks stay out of this run
    '--ignore-rules',
    '--ephemeral',
    '--color', 'never',
    '--json',
    '-C', workdir,
    '-c', 'approval_policy="never"',
    '-c', 'mcp_servers={}',
    '-c', 'sandbox_mode="read-only"',
    '-c', 'tools.web_search=false',
    '--output-last-message', lastMessage,
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (schemaFile) args.push('--output-schema', schemaFile);
  args.push('-'); // prompt on stdin

  const bin = resolveCommand(p.command || 'codex');
  try {
    const r = await run(bin.command, [...bin.prefixArgs, ...args], {
      cwd: workdir,
      stdin: packet,
      timeoutMs,
      maxOutputChars: config.limits.maxOutputChars,
      env: { [DEPTH_VAR]: '1', ...(p.home ? { CODEX_HOME: p.home } : {}) },
    });
    let answer = '';
    try { answer = fs.readFileSync(lastMessage, 'utf8').trim(); } catch { /* fall back to the event stream */ }
    if (!answer) answer = codexAnswerFromEvents(r.stdout);
    return finishCodex(r, answer, schema);
  } finally {
    unlinkQuietly(lastMessage);
    unlinkQuietly(schemaFile);
  }
}

function codexAnswerFromEvents(stdout) {
  let last = '';
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const msg = ev?.msg ?? ev;
    const type = msg?.type || ev?.type;
    if (type === 'agent_message' && typeof msg.message === 'string') last = msg.message;
    else if (type === 'item.completed' && typeof msg?.item?.text === 'string') last = msg.item.text;
    else if (type === 'task_complete' && typeof msg.last_agent_message === 'string') last = msg.last_agent_message;
  }
  return last.trim();
}

// --------------------------------------------------------------- antigravity

/**
 * `--mode plan` is the CLI's read-only mode. It works through slash-command expansion,
 * so `--disable-slash-commands` must never be added: it silently turns plan mode off.
 * No permission-skipping flag is ever passed, so headless runs decline any tool that
 * would need a confirmation.
 *
 * The packet goes in on stdin as one stream-json message, not as an argument: an argument
 * is visible to other users in the process list, and Windows caps a command line at
 * about 32k characters.
 */
export async function callAntigravity({ packet, workdir, model, timeoutMs, schema }) {
  const p = config.providers.antigravity;
  const bin = resolveCommand(p.command || 'agy');
  const schemaFile = writeSchema(schema, 'gauntlet-agy-schema');
  const args = [
    ...bin.prefixArgs,
    '--mode', 'plan',
    '--sandbox',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    // A little under our own deadline, so the CLI gets to exit cleanly first.
    '--print-timeout', `${Math.max(30, Math.floor((timeoutMs - 10000) / 1000))}s`,
  ];
  if (model) args.push('--model', model);
  if (Array.isArray(p.extraArgs)) args.push(...p.extraArgs.map(String));
  if (schemaFile) args.push('--json-schema', schemaFile);
  args.push('--print', '');

  try {
    const r = await run(bin.command, args, {
      cwd: workdir,
      stdin: `${JSON.stringify({ event: 'user', message: { role: 'user', content: packet } })}\n`,
      timeoutMs,
      // The event stream repeats the answer (response and structured_output) next to a
      // long init event, so it needs more room than the answer alone.
      maxOutputChars: config.limits.maxOutputChars * 4,
      env: {
        [DEPTH_VAR]: '1', NO_COLOR: '1', TERM: 'dumb',
        ...(p.home ? { HOME: p.home, USERPROFILE: p.home } : {}),
      },
    });
    return finishAntigravity(r, schema);
  } finally {
    unlinkQuietly(schemaFile);
  }
}

/** The `result` event closes a stream-json run: status, answer, structured output, usage. */
export function antigravityResult(stdout) {
  let result = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.includes('"result"')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.event === 'result' && ev.result && typeof ev.result === 'object') result = ev.result;
    } catch { /* not an event line */ }
  }
  return result;
}

function finishAntigravity(r, schema) {
  if (r.timedOut) throw new RunError('timeout', 'antigravity ran out of time and was stopped');
  const res = antigravityResult(r.stdout);
  const detail = { exitCode: r.code, stderrTail: tail(r.stderr, 600) };
  if (!res) {
    const kind = classifyFailure(`${r.stderr}\n${r.stdout}`);
    throw new RunError(kind || (r.code !== 0 ? 'provider_error' : 'empty_response'), `antigravity: ${kind || 'no result event'}`, detail);
  }
  if (res.status !== 'SUCCESS') {
    const kind = classifyFailure(`${res.error || ''}\n${r.stderr}`) || 'provider_error';
    throw new RunError(kind, `antigravity: ${res.error || res.status}`, { ...detail, stderrTail: tail(res.error || r.stderr, 600) });
  }
  const answer = String(res.response || '').trim();
  const structured = res.structured_output && typeof res.structured_output === 'object' ? res.structured_output : null;
  if (!answer && !structured) throw new RunError('empty_response', 'antigravity returned no answer', detail);
  const u = res.usage;
  return {
    provider: 'antigravity',
    text: answer || JSON.stringify(structured),
    json: schema ? (structured || extractJson(answer)) : null,
    durationMs: r.durationMs,
    truncated: r.truncated,
    usage: u ? { inputTokens: u.input_tokens ?? null, cachedInputTokens: u.cache_read_tokens ?? null, outputTokens: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0) } : null,
  };
}

// -------------------------------------------------------------------- shared

/** Why a run failed, from the CLI's own words (neither CLI has stable error codes). */
export function classifyFailure(text) {
  const t = String(text || '');
  if (/usage limit|rate.?limit|quota|\b429\b|resource.?exhausted|too many requests|limit (has been )?reached|out of credits|insufficient.?credits|try again (later|in \d)/i.test(t)) return 'quota';
  if (/requires a newer version|model[^\n]{0,60}(not (found|supported|available)|does not exist|is not enabled)|unknown model|invalid model|unsupported model/i.test(t)) return 'model_unavailable';
  if (/not logged in|\bunauthori[sz]ed\b|\b401\b|login required|please (log|sign) ?in|authentication (failed|required)/i.test(t)) return 'auth';
  return null;
}

function tail(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
}

function finishCodex(r, answer, schema) {
  if (r.timedOut) throw new RunError('timeout', 'codex ran out of time and was stopped');
  // Only error-looking stdout lines count: Codex reports its rate-limit headroom on every
  // successful turn, and that must not read as a quota failure.
  const errorLines = String(r.stdout).split(/\r?\n/).filter((l) => /error/i.test(l)).join('\n');
  const kind = classifyFailure(`${r.stderr}\n${errorLines}`);
  if (!answer || (r.code !== 0 && kind)) {
    const detail = { exitCode: r.code, stderrTail: tail(r.stderr, 600) };
    if (kind) throw new RunError(kind, `codex: ${kind}`, detail);
    if (r.code !== 0) throw new RunError('provider_error', `codex exited with code ${r.code}`, detail);
    throw new RunError('empty_response', 'codex returned no answer', detail);
  }
  return {
    provider: 'codex',
    text: answer,
    json: schema ? extractJson(answer) : null,
    durationMs: r.durationMs,
    truncated: r.truncated,
    usage: codexUsage(r.stdout),
  };
}

/** Token counts from the turn.completed event, when Codex reports them. */
function codexUsage(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.includes('usage') || !line.trim().startsWith('{')) continue;
    try {
      const o = JSON.parse(line);
      const u = o.usage || o.msg?.usage;
      if (u) {
        return {
          inputTokens: u.input_tokens ?? null,
          cachedInputTokens: u.cached_input_tokens ?? null,
          outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
        };
      }
    } catch { /* not an event line */ }
  }
  return null;
}

// -------------------------------------------------------------------- status

async function probe(bin, args, env) {
  try {
    const r = await run(bin.command, [...bin.prefixArgs, ...args], { timeoutMs: 25000, maxOutputChars: 2000, cwd: os.tmpdir(), env });
    return { ok: r.code === 0, line: (r.stdout || r.stderr).trim().split(/\r?\n/)[0] || '' };
  } catch (err) {
    return { ok: false, line: '', error: err.kind || 'not_found' };
  }
}

/** Installed? Signed in? Presence only: no credential file is ever opened. */
export async function providerStatus() {
  const out = {};

  const cx = config.providers.codex;
  const cxBin = resolveCommand(cx.command || 'codex');
  const cxEnv = cx.home ? { CODEX_HOME: cx.home } : {};
  const cxVersion = await probe(cxBin, ['--version'], cxEnv);
  out.codex = { installed: cxVersion.ok, version: cxVersion.ok ? cxVersion.line : null, command: cxBin.command };
  if (cxVersion.ok) {
    const login = await probe(cxBin, ['login', 'status'], cxEnv);
    out.codex.signedIn = login.ok && /logged in/i.test(login.line);
    out.codex.method = /chatgpt/i.test(login.line) ? 'ChatGPT subscription' : /api key/i.test(login.line) ? 'API key' : null;
  }

  const ag = config.providers.antigravity;
  const agBin = resolveCommand(ag.command || 'agy');
  const agVersion = await probe(agBin, ['--version'], ag.home ? { HOME: ag.home, USERPROFILE: ag.home } : {});
  out.antigravity = { installed: agVersion.ok, version: agVersion.ok ? agVersion.line : null, command: agBin.command };
  if (agVersion.ok) {
    const home = ag.home || os.homedir();
    const dirs = [path.join(home, '.gemini', 'antigravity-cli'), path.join(home, '.antigravity')];
    if (process.env.LOCALAPPDATA && !ag.home) dirs.push(path.join(process.env.LOCALAPPDATA, 'agy'));
    out.antigravity.signedIn = dirs.some((d) => { try { return fs.readdirSync(d).length > 0; } catch { return false; } });
  }
  return out;
}
