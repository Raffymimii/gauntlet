#!/usr/bin/env node
// What happened in your own Claude Code sessions after a second opinion.
//
//   node bench/real-world.mjs [~/.claude/projects] [--json]
//
// Reads the conversation transcripts Claude Code keeps on disk and, for every review a
// Gauntlet tool returned, works out:
//   - whether the reviewed code was Claude's own (it edited those files earlier in the
//     session, or the review was of a diff after edits);
//   - whether the review raised a critical, high or medium finding that wasn't marked "could not
//     be confirmed";
//   - what Claude did next, until the next review: changed code (an edit tool, or a shell
//     command that writes files), said it was a false positive, or accepted it in words.
//
// Only counts leave this script; nothing from the transcripts is printed. It recognises the
// tool prefix of Gauntlet (mcp__gauntlet__) and of the project it grew out of
// (mcp__multimodel__).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(os.homedir(), '.claude', 'projects');
const asJson = process.argv.includes('--json');

const PREFIX = /^mcp__(gauntlet|multimodel)__/;
const REVIEWS = new Set(['codex_review', 'gemini_review', 'quick_check', 'security_audit', 'council', 'edge_cases']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_WRITES = /sed -i|apply_patch|Set-Content|Out-File|writeFileSync|write_text|open\([^)]*['"]w|>\s*[\w./-]+\.(js|ts|tsx|mjs|py|java|kt|go|rs|php|json|ya?ml|sql|css|html)\b|scp |git apply|patch -p/;
const REJECTED = /falso positiv|false positive|non è un bug|not a (real )?bug|non si applica|doesn't apply|does not apply|already handled|già gestit|infondat|unfounded|non regge/;
const ACCEPTED = /you're right|good catch|real bug|\bvalid\b|\bfix(ing|ed)?\b|i'll (fix|change|correct)|hai ragione|ha ragione|correggo|sistemo|vero bug|applico|confermat/;
const WINDOW = 120; // events after the review, at most, before it stops counting as a response

function transcripts(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...transcripts(p));
    else if (d.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const textOf = (c) => (Array.isArray(c) ? c.map((x) => x.text || (typeof x.content === 'string' ? x.content : '')).join('\n') : String(c ?? ''));
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
const base = (p) => norm(p).split('/').pop();

/** An edited (usually absolute) path against a path a review names (usually project-relative). */
function sameFile(edited, named) {
  const a = norm(edited);
  const b = norm(named);
  return Boolean(a && b) && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`));
}

/** Files a unified diff touches. */
function diffFiles(diff) {
  const out = [];
  for (const m of String(diff || '').matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) if (m[1] !== '/dev/null') out.push(m[1]);
  return out;
}

const editedPath = (y) => y.input.file_path || y.input.notebook_path;

/** Findings in a review: "**[high]** `file:line` ..." lines, with the section they sit in. */
function findingsOf(text) {
  const out = [];
  let section = 'unknown';
  for (const line of text.split('\n')) {
    if (/^##\s*Could not be confirmed/i.test(line)) section = 'unconfirmed';
    else if (/^##\s*(Findings|Raised)/i.test(line)) section = 'findings';
    else if (/^##\s/.test(line)) section = 'other';
    const m = line.match(/\*\*\[(critical|high|medium|low|info)\]/i);
    if (!m || section === 'other') continue;
    const loc = line.match(/`?([\w./\\-]+\.[a-zA-Z0-9]+):\d+`?/);
    out.push({ severity: m[1].toLowerCase(), file: loc ? loc[1] : null, unconfirmed: section === 'unconfirmed' });
  }
  return out;
}

function events(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const c = e.message?.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'tool_use') out.push({ kind: 'use', id: b.id, name: b.name, input: b.input || {} });
        else if (b.type === 'tool_result') out.push({ kind: 'result', id: b.tool_use_id, text: textOf(b.content), error: Boolean(b.is_error) });
        else if (b.type === 'text') out.push({ kind: e.type === 'assistant' ? 'said' : 'heard', text: b.text || '' });
      }
    } else if (typeof c === 'string') out.push({ kind: e.type === 'assistant' ? 'said' : 'heard', text: c });
  }
  return out;
}

const s = { sessions: 0, reviews: 0, ownCode: 0, ownSerious: 0, changed: 0, rejected: 0, accepted: 0, noComment: 0 };

for (const file of transcripts(root)) {
  let ev;
  try { ev = events(file); } catch { continue; }
  if (!ev.some((x) => x.kind === 'use' && PREFIX.test(x.name))) continue;
  s.sessions++;
  const results = new Map(ev.filter((x) => x.kind === 'result').map((x) => [x.id, x]));

  ev.forEach((x, i) => {
    if (x.kind !== 'use' || !PREFIX.test(x.name)) return;
    const tool = x.name.replace(PREFIX, '');
    if (!REVIEWS.has(tool)) return;

    let res = results.get(x.id);
    let text = res?.text || '';
    let at = ev.indexOf(res);
    // A long review is moved to the background and arrives later as a notification.
    const bg = text.match(/background as task (\w+)/);
    if (bg) {
      at = ev.findIndex((y, k) => k > i && y.kind === 'heard' && y.text.includes(bg[1]) && /\*\*\[|verdict/i.test(y.text));
      text = at >= 0 ? ev[at].text : '';
    }
    if (!text || res?.error || at < 0) return;
    s.reviews++;

    const findings = findingsOf(text);
    const serious = findings.filter((f) => ['critical', 'high', 'medium'].includes(f.severity) && !f.unconfirmed);
    // Own code: Claude edited, earlier in this session, a file the review is about.
    const reviewed = [...(x.input.paths || []), ...diffFiles(x.input.diff), ...findings.map((f) => f.file)].filter(Boolean);
    const before = ev.slice(0, i).filter((y) => y.kind === 'use' && EDIT_TOOLS.has(y.name));
    if (!before.some((y) => reviewed.some((r) => sameFile(editedPath(y), r)))) return;
    s.ownCode++;
    if (!serious.length) return;
    s.ownSerious++;

    // Changed: an edit to a file a serious finding names, before the next review. A shell
    // command counts only if it writes and names one of those files.
    const flagged = serious.map((f) => f.file).filter(Boolean);
    const targets = flagged.length ? flagged : reviewed;
    const after = ev.slice(at + 1, at + 1 + WINDOW);
    const next = after.findIndex((y) => y.kind === 'use' && PREFIX.test(y.name) && REVIEWS.has(y.name.replace(PREFIX, '')));
    const span = next >= 0 ? after.slice(0, next) : after;
    const touches = (y) => {
      if (y.kind !== 'use') return false;
      if (EDIT_TOOLS.has(y.name)) return targets.some((t) => sameFile(editedPath(y), t));
      const cmd = String(y.input.command || '');
      return /^(Bash|PowerShell)$/.test(y.name) && SHELL_WRITES.test(cmd) && targets.some((t) => cmd.toLowerCase().includes(base(t)));
    };
    if (span.some(touches)) s.changed++;
    const said = span.filter((y) => y.kind === 'said').slice(0, 3).map((y) => y.text.toLowerCase()).join(' ');
    if (REJECTED.test(said)) s.rejected++;
    else if (ACCEPTED.test(said)) s.accepted++;
    else s.noComment++;
  });
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
if (asJson) {
  console.log(JSON.stringify(s, null, 1));
} else {
  console.log(`Sessions with Gauntlet reviews:              ${s.sessions}`);
  console.log(`Reviews that returned an answer:             ${s.reviews}`);
  console.log(`  of code Claude had just written:           ${s.ownCode}`);
  console.log(`    with a critical, high or medium finding: ${s.ownSerious} (${pct(s.ownSerious, s.ownCode)})`);
  console.log(`      Claude then changed a flagged file:    ${s.changed} (${pct(s.changed, s.ownSerious)})`);
  console.log(`      Claude called it a false positive:     ${s.rejected} (${pct(s.rejected, s.ownSerious)})`);
}
