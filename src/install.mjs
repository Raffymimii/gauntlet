// `tandem init` and `tandem uninstall`.
//
// What gets touched, and how it is undone:
//   MCP server   registered through the official `claude mcp add` command (user scope)
//   subagents    copied to ~/.claude/agents, each marked as installed by tandem; a file
//                of the same name that tandem didn't install is left alone
//   hooks        only with --hooks; merged into ~/.claude/settings.json after a backup,
//                every entry tagged with --tandem so it can be found and removed again
//   CLAUDE.md    only with --claude-md; one @-include line, tagged
// Every step prints what it did. --dry-run prints and changes nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PACKAGE_ROOT } from './config.mjs';
import { resolveCommand } from './process.mjs';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const AGENTS_DIR = path.join(CLAUDE_DIR, 'agents');
const CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');

const TAG = '--tandem';
const AGENT_MARK = '<!-- installed by tandem -->';
const MD_MARK = '<!-- tandem -->';

const slash = (p) => p.split(path.sep).join('/');

// Hook commands go through a shell. Inside double quotes a shell still expands $, ` and
// \, so a package path containing them could run something. Refuse rather than escape.
export function assertSafePath(p) {
  if (/["$`\\!\n\r]/.test(slash(p))) {
    throw new Error(`tandem is installed in a path with characters that are unsafe in a shell command (${p}). Move it to a plain path and run init again.`);
  }
  return slash(p);
}

const nodeCmd = (script) => `node "${assertSafePath(path.join(PACKAGE_ROOT, script))}" ${TAG}`;

// Functions, so that merely importing this module (tests, `tandem help`) never throws on
// an unsafe install path; the check runs when hooks are actually being written.
export const HOOK_SETS = {
  turn: () => ({
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: nodeCmd('hooks/turn.mjs'), timeout: 60 }] }],
    Stop: [{ hooks: [{ type: 'command', command: nodeCmd('hooks/turn.mjs'), timeout: 15 }] }],
  }),
  'review-gate': () => ({
    PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: nodeCmd('hooks/review-gate.mjs'), timeout: 10 }] }],
    PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Agent|Task|mcp__tandem__.*', hooks: [{ type: 'command', command: nodeCmd('hooks/review-gate.mjs'), timeout: 10 }] }],
  }),
};

const ours = (h) => typeof h?.command === 'string' && h.command.endsWith(` ${TAG}`);

/** Settings with every tandem hook removed; groups left empty are dropped. */
export function withoutTandemHooks(settings) {
  const out = structuredClone(settings);
  for (const [event, groups] of Object.entries(out.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) out.hooks[event] = kept; else delete out.hooks[event];
  }
  if (out.hooks && !Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

export function withTandemHooks(settings, sets) {
  const out = withoutTandemHooks(settings);
  for (const name of sets) {
    for (const [event, groups] of Object.entries(HOOK_SETS[name]())) {
      out.hooks ??= {};
      out.hooks[event] = [...(out.hooks[event] || []), ...groups];
    }
  }
  return out;
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${SETTINGS} is not valid JSON (${err.message}). Fix it first; tandem will not overwrite a file it cannot read.`);
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const to = `${file}.tandem-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, to);
  return to;
}

function claude(args) {
  const bin = resolveCommand('claude');
  const r = spawnSync(bin.command, [...bin.prefixArgs, ...args], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: Boolean(r.error) };
}

function guardCommand() {
  return `node "${assertSafePath(path.join(PACKAGE_ROOT, 'hooks', 'readonly-guard.mjs'))}"`;
}

export function init({ hooks = [], claudeMd = false, forceAgents = false, testAnalyst = false, dryRun = false, log = console.log }) {
  const unknown = hooks.filter((h) => !HOOK_SETS[h]);
  if (unknown.length) throw new Error(`unknown hook set: ${unknown.join(', ')} (available: ${Object.keys(HOOK_SETS).join(', ')})`);
  const act = (what, fn) => { log(`${dryRun ? '[dry run] would ' : ''}${what}`); if (!dryRun) fn(); };

  // 1. MCP server
  const server = slash(path.join(PACKAGE_ROOT, 'src', 'server.mjs'));
  const existing = claude(['mcp', 'get', 'tandem']);
  if (existing.missing) {
    log(`! the claude CLI was not found. Register the server yourself:\n    claude mcp add --scope user tandem -- node "${server}"`);
  } else if (existing.ok) {
    log('- MCP server "tandem" is already registered');
  } else {
    act(`register the MCP server: claude mcp add --scope user tandem -- node "${server}"`, () => {
      const r = claude(['mcp', 'add', '--scope', 'user', 'tandem', '--', 'node', server]);
      if (!r.ok) throw new Error(`claude mcp add failed: ${r.out}`);
    });
  }

  // 2. Subagents
  for (const file of fs.readdirSync(path.join(PACKAGE_ROOT, 'claude', 'agents'))) {
    // This one runs the project's own tests and builds, i.e. the project's code: opt-in.
    if (file === 'sonnet-test-analyst.md' && !testAnalyst) {
      log(`- skipped ${file}: it runs your project's tests and builds, so it is opt-in (--test-analyst)`);
      continue;
    }
    const dest = path.join(AGENTS_DIR, file);
    if (fs.existsSync(dest) && !fs.readFileSync(dest, 'utf8').includes(AGENT_MARK) && !forceAgents) {
      log(`- skipped ${dest}: a file you wrote already has that name (use --force-agents to replace it)`);
      continue;
    }
    const body = fs.readFileSync(path.join(PACKAGE_ROOT, 'claude', 'agents', file), 'utf8').replaceAll('{{GUARD_COMMAND}}', guardCommand());
    act(`install subagent ${dest}`, () => writeAtomic(dest, `${body.trimEnd()}\n\n${AGENT_MARK}\n`));
  }

  // 3. Hooks, only when asked for
  if (hooks.length) {
    const next = withTandemHooks(readSettings(), hooks);
    act(`add hooks (${hooks.join(', ')}) to ${SETTINGS}`, () => {
      const b = backup(SETTINGS);
      if (b) log(`  backup: ${b}`);
      writeAtomic(SETTINGS, `${JSON.stringify(next, null, 2)}\n`);
    });
  }

  // 4. CLAUDE.md, only when asked for
  const include = `@${slash(path.join(PACKAGE_ROOT, 'prompts', 'orchestrator.md'))} ${MD_MARK}`;
  if (claudeMd) {
    const current = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, 'utf8') : '';
    if (current.includes(MD_MARK)) log(`- ${CLAUDE_MD} already includes the tandem rules`);
    else act(`add the tandem rules to ${CLAUDE_MD}`, () => { backup(CLAUDE_MD); writeAtomic(CLAUDE_MD, `${current.trimEnd()}\n\n${include}\n`); });
  } else {
    log(`- to give Claude the working rules, add this line to ${CLAUDE_MD} (or rerun with --claude-md):\n    ${include.replace(` ${MD_MARK}`, '')}`);
  }

  log('\nDone. Open a NEW Claude Code chat: MCP servers and CLAUDE.md are only read when a chat starts.');
  log('Then run `tandem status` to check that Codex and Antigravity are installed and signed in.');
}

export function uninstall({ dryRun = false, log = console.log }) {
  const act = (what, fn) => { log(`${dryRun ? '[dry run] would ' : ''}${what}`); if (!dryRun) fn(); };

  const r = claude(['mcp', 'get', 'tandem']);
  if (r.ok) act('remove the MCP server "tandem"', () => claude(['mcp', 'remove', '--scope', 'user', 'tandem']));

  if (fs.existsSync(AGENTS_DIR)) {
    for (const f of fs.readdirSync(AGENTS_DIR)) {
      const p = path.join(AGENTS_DIR, f);
      try { if (fs.readFileSync(p, 'utf8').includes(AGENT_MARK)) act(`remove subagent ${p}`, () => fs.unlinkSync(p)); } catch { /* not a file */ }
    }
  }

  const settings = readSettings();
  const cleaned = withoutTandemHooks(settings);
  if (JSON.stringify(cleaned) !== JSON.stringify(settings)) {
    act(`remove tandem hooks from ${SETTINGS}`, () => { backup(SETTINGS); writeAtomic(SETTINGS, `${JSON.stringify(cleaned, null, 2)}\n`); });
  }

  if (fs.existsSync(CLAUDE_MD)) {
    const md = fs.readFileSync(CLAUDE_MD, 'utf8');
    if (md.includes(MD_MARK)) {
      act(`remove the tandem line from ${CLAUDE_MD}`, () => writeAtomic(CLAUDE_MD, md.split('\n').filter((l) => !l.includes(MD_MARK)).join('\n')));
    }
  }
  log('\nDone. Your data in ~/.tandem (events, cache, runtime versions) was left in place; delete it by hand if you want it gone.');
}
