#!/usr/bin/env node
// Optional review gate (install with `tandem init --hooks review-gate`).
//
//   PostToolUse Edit/Write/...           remembers which code files changed this session
//   PostToolUse on a tandem review tool  or the sonnet-reviewer / opus-architect subagent:
//                                        the changes so far count as reviewed
//   PostToolUse, many unreviewed edits   a one-line reminder in Claude's context
//   PreToolUse Bash/PowerShell           a push or deploy is denied while code changes are
//                                        unreviewed, unless the command contains
//                                        "# review-skip: <reason>"
//
// "Reviewed" means a review tool ran after the edits, not that its verdict was positive:
// the gate makes sure a second opinion was asked for, the decision stays with Claude and
// you. It fails open: a bug here must never stop work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR = path.join(process.env.TANDEM_HOME || path.join(os.homedir(), '.tandem'), 'state', 'review-gate');
const FILES_THRESHOLD = 3;
const EDITS_THRESHOLD = 8;
const REMIND_EVERY = 5;

const REVIEW_TOOL = /^mcp__tandem__(codex_review|gemini_review|council|quick_check|security_audit|edge_cases|codex_diagnose|plan_critique)$/;
const REVIEW_AGENT = /^(sonnet-reviewer|opus-architect)$/;

// Commands that put code in front of other people.
const DEPLOY = new RegExp([
  String.raw`\bgit\b(?:\s+-{1,2}[\w-]+(?:[= ](?!push\b)\S+)?)*\s+push\b(?![^\n;&|]*--dry-run)`,
  String.raw`(?:^|[;&|'"(]\s*|\b(?:bash|sh|zsh)\s+)(?:[\w.~/-]*/)?deploy\.sh\b`,
  String.raw`\bnpm\s+run\s+deploy\b`,
  String.raw`\bnpm\s+publish\b`,
  String.raw`\bvercel\b[^;&|]*--prod`,
  String.raw`\bfirebase\s+deploy\b`,
  String.raw`\bwrangler\s+(?:deploy|publish)\b`,
  String.raw`\bfly\s+deploy\b`,
  String.raw`\bgh\s+release\s+create\b`,
].join('|'), 'im');

const NOT_CODE = /\.(md|mdx|txt|log|csv|png|jpe?g|gif|svg|ico|webp|lock)$/i;

const done = () => { process.exitCode = 0; };
const say = (o) => { process.stdout.write(JSON.stringify(o)); };

function isCode(p) {
  const n = p.replace(/\\/g, '/');
  return !NOT_CODE.test(n) && !/\/(te?mp|scratchpad)\/|\/\.claude\/(projects|plans)\//i.test(n);
}

function load(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { unreviewed: s.unreviewed || {}, edits: s.edits || 0, remindedAt: s.remindedAt || 0 }; } catch { return { unreviewed: {}, edits: 0, remindedAt: 0 }; }
}

function save(file, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    const cutoff = Date.now() - 7 * 86_400_000;
    for (const f of fs.readdirSync(STATE_DIR)) {
      const p = path.join(STATE_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  } catch { /* fail open */ }
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const event = input.hook_event_name;
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const session = String(input.session_id || 'none').replace(/[^\w-]/g, '').slice(0, 80) || 'none';
  const file = path.join(STATE_DIR, `${session}.json`);
  const state = load(file);

  if (event === 'PreToolUse' && (tool === 'Bash' || tool === 'PowerShell')) {
    const cmd = String(ti.command || '');
    if (!DEPLOY.test(cmd) || /#\s*review-skip:/i.test(cmd)) return;
    const pending = Object.keys(state.unreviewed);
    if (!pending.length) return;
    say({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Push/deploy blocked: ${pending.length} code file(s) changed with no review (${pending.slice(0, 4).map((p) => path.basename(p)).join(', ')}${pending.length > 4 ? ', ...' : ''}). `
          + 'Get a review first (quick_check for small changes, codex_review or council for risky ones), then run the command again. '
          + 'For a genuinely trivial change, append "# review-skip: <reason>" to the command.',
      },
    });
    return;
  }
  if (event !== 'PostToolUse') return;

  if (REVIEW_TOOL.test(tool) || ((tool === 'Agent' || tool === 'Task') && REVIEW_AGENT.test(String(ti.subagent_type || '')))) {
    save(file, { unreviewed: {}, edits: 0, remindedAt: 0, lastReview: Date.now() });
    return;
  }

  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return;
  const target = String(ti.file_path || ti.notebook_path || '');
  if (!target || !isCode(target)) return;
  state.unreviewed[target] = (state.unreviewed[target] || 0) + 1;
  state.edits += 1;
  const files = Object.keys(state.unreviewed).length;
  const due = (files >= FILES_THRESHOLD || state.edits >= EDITS_THRESHOLD) && (!state.remindedAt || state.edits - state.remindedAt >= REMIND_EVERY);
  if (due) state.remindedAt = state.edits;
  save(file, state);
  if (due) {
    say({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[tandem] ${files} code file(s) / ${state.edits} edit(s) with no outside review. When this piece of work is stable, ask for one at the right tier: quick_check for small things, codex_review or gemini_review otherwise, council or security_audit for auth, payments, data or production.`,
      },
    });
  }
}

try { main(); } catch { /* fail open */ }
done();
