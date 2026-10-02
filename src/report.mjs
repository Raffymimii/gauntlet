// Renders a checked, structured answer as markdown for Claude to read.
//
// Three groups: findings whose quote was found in the file, findings that could not be
// checked (no quote, or about the plan), and findings that point at code that is not
// there. The last group is shown, not hidden: "the reviewer made this up" is worth knowing.

import { SUSPECT } from './verify.mjs';

const ORDER = { high: 0, medium: 1, low: 2 };
const bySeverity = (a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3);

function where(c) {
  if (!c.file || c.file === 'PLAN') return '';
  const line = c.foundAtLine ?? c.line;
  return line ? `${c.file}:${line}` : c.file;
}

function age(ts) {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function item(c, n) {
  const w = where(c);
  const seen = c.memory?.repeat ? ` (seen before, first ${age(c.memory.firstSeen)})` : '';
  const lines = [`${n}. **[${c.severity ?? '?'}]** ${w ? `\`${w}\`: ` : ''}${c.claim}${seen}`];
  if (c.verifyReason === 'other_line') lines.push(`   (stated line ${c.line}; the quoted code is at ${c.foundAtLine})`);
  if (c.fix) lines.push(`   Fix: ${String(c.fix).replace(/\n+/g, ' ')}`);
  return lines.join('\n');
}

export function renderReport(answer, v, memory = []) {
  const out = [];
  if (answer.verdict) out.push(`**Verdict: ${answer.verdict.replace(/_/g, ' ')}** (confidence ${answer.confidence ?? 'unstated'})`);
  else if (answer.answer) out.push(answer.answer.trim(), '', `_Confidence: ${answer.confidence ?? 'unstated'}_`);
  if (answer.summary) out.push(answer.summary.trim());

  const claims = v.claims.map((c, i) => ({ ...c, memory: memory[i] }));
  const checked = claims.filter((c) => c.verified).sort(bySeverity);
  const failed = claims.filter((c) => !c.verified && SUSPECT.has(c.verifyReason)).sort(bySeverity);
  const unchecked = claims.filter((c) => !c.verified && !SUSPECT.has(c.verifyReason)).sort(bySeverity);

  if (checked.length) {
    out.push('', `## Findings verified against the files (${checked.length})`);
    checked.forEach((c, i) => out.push(item(c, i + 1)));
  }
  if (unchecked.length) {
    out.push('', `## Findings not checkable against a file (${unchecked.length})`);
    unchecked.forEach((c, i) => out.push(item(c, i + 1)));
  }
  if (failed.length) {
    out.push('', `## Could not be confirmed (${failed.length})`, '_The quoted code, file or line is not there. Treat with suspicion._');
    for (const c of failed) out.push(`- **[${c.severity ?? '?'}]** ${where(c) ? `\`${where(c)}\`: ` : ''}${c.claim} (${c.verifyNote})`);
  }
  if (!claims.length) out.push('', 'No findings.');

  if (answer.structure?.length) {
    out.push('', '## How it fits together');
    for (const s of answer.structure) out.push(`- **${s.part}**${s.file ? ` (\`${s.file}\`)` : ''}: ${s.role}`);
  }
  if (answer.missed_edge_cases?.length) {
    out.push('', '## Unhandled edge cases');
    for (const e of answer.missed_edge_cases) out.push(`- ${e}`);
  }
  if (answer.unanswered?.length) {
    out.push('', '## Not checked');
    for (const u of answer.unanswered) out.push(`- ${u}`);
  }
  return out.join('\n');
}
