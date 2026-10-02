// Running provider CLIs: hard timeout, whole-tree kill, capped output, scrubbed
// environment, prompt on stdin so it never shows up in a process listing.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { childEnv } from './redact.mjs';

export class RunError extends Error {
  constructor(kind, message, detail = {}) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * @returns {Promise<{code, signal, stdout, stderr, truncated, timedOut, durationMs}>}
 */
export function run(command, args, { cwd, stdin = '', timeoutMs = 300000, maxOutputChars = 60000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: childEnv(env),
        windowsHide: true,
        detached: process.platform !== 'win32', // own process group, so the kill takes the children too
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new RunError('spawn_failed', `cannot start ${command}: ${err.code || err.message}`));
      return;
    }

    let out = '';
    let errOut = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const errCap = Math.min(8000, maxOutputChars);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (out.length >= maxOutputChars) { truncated = true; return; }
      out += d;
      if (out.length > maxOutputChars) { out = out.slice(0, maxOutputChars); truncated = true; }
    });
    child.stderr.on('data', (d) => {
      if (errOut.length < errCap) errOut = (errOut + d).slice(0, errCap);
    });

    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new RunError('spawn_failed', `cannot start ${command}: ${err.code || err.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout: out, stderr: errOut, truncated, timedOut, durationMs: Date.now() - started });
    });

    child.stdin.on('error', () => { /* the CLI may close stdin early */ });
    child.stdin.end(stdin, 'utf8');
  });
}

// ---------------------------------------------------------------------------
// Command resolution. On Windows npm installs CLIs as .cmd shims, which Node
// will not spawn without a shell. Instead of `shell: true` (and cmd.exe
// re-parsing our arguments) we find the real executable, or the JS file the
// shim would have run, and spawn that directly.

const resolved = new Map();

function entryFromShim(shimPath) {
  let body;
  try { body = fs.readFileSync(shimPath, 'utf8'); } catch { return null; }
  const m = body.match(/["']?(?:%dp0%|\$basedir)[\\/]((?:[^"'\s\\/]+[\\/])*[^"'\s\\/]+\.[cm]?js)["']?/);
  if (!m) return null;
  const abs = path.resolve(path.dirname(shimPath), m[1]);
  return fs.existsSync(abs) ? abs : null;
}

/** @returns {{command: string, prefixArgs: string[], via: string}} */
export function resolveCommand(name) {
  if (!resolved.has(name)) resolved.set(name, findCommand(name));
  return resolved.get(name);
}

function findCommand(name) {
  if (name.includes('/') || name.includes('\\')) {
    if (/\.[cm]?js$/i.test(name)) return { command: process.execPath, prefixArgs: [name], via: 'node-script' };
    return { command: name, prefixArgs: [], via: 'explicit' };
  }
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const win = process.platform === 'win32';

  for (const d of dirs) {
    for (const ext of win ? ['.exe', '.com'] : ['']) {
      const p = path.join(d, name + ext);
      try { if (fs.statSync(p).isFile()) return { command: p, prefixArgs: [], via: 'path' }; } catch { /* next */ }
    }
  }
  if (win) {
    for (const d of dirs) {
      for (const ext of ['.cmd', '.bat', '']) {
        const entry = entryFromShim(path.join(d, name + ext));
        if (entry) return { command: process.execPath, prefixArgs: [entry], via: 'npm-shim' };
      }
    }
  }
  return { command: name, prefixArgs: [], via: 'unresolved' }; // spawn will fail with a clear error
}
