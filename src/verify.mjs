// Checks what a specialist claims against what is actually in the files.
//
// It doesn't judge whether a finding matters; it checks that the file exists, the line
// exists, and the quoted code is really there. That catches the failure that hurts most:
// a confident, well-written finding about code that doesn't exist. No model involved.
import fs from 'node:fs';
import path from 'node:path';
import { inside } from './packet.mjs';

const LINE_SLACK = 3; // a model one or two lines out is still pointing at the right thing
const MIN_QUOTE = 8; // shorter quotes match too easily to mean anything

// Named a file, line or quote that doesn't hold up: worth being loud about.
export const SUSPECT = new Set(['quote_not_found', 'file_not_found', 'line_past_end', 'outside_project']);

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

const REASONS = {
  no_file: 'no file named',
  about_plan: 'about the plan, nothing to check on disk',
  outside_project: 'points outside the project',
  file_not_found: 'that file does not exist',
  line_past_end: 'that line is past the end of the file',
  no_quote: 'nothing quoted to check',
  quote_not_found: 'the quoted text is not in that file',
  other_line: 'real, but at a different line than stated',
};

function check(claim, workdir, files) {
  if (!claim.file) return { verified: false, reason: 'no_file' };
  // Plan critiques point at the plan itself, which is not a file on disk.
  if (claim.file === 'PLAN') return { verified: false, reason: 'about_plan' };
  const abs = path.resolve(workdir, claim.file);
  if (!inside(abs, workdir)) return { verified: false, reason: 'outside_project' };

  if (!files.has(abs)) {
    try { files.set(abs, fs.readFileSync(abs, 'utf8').split(/\r?\n/)); } catch { files.set(abs, null); }
  }
  const lines = files.get(abs);
  if (!lines) return { verified: false, reason: 'file_not_found' };
  if (claim.line != null && claim.line > lines.length) return { verified: false, reason: 'line_past_end' };
  if (!claim.evidence || norm(claim.evidence).length < MIN_QUOTE) return { verified: false, reason: 'no_quote' };

  const needle = norm(claim.evidence);
  if (claim.line != null) {
    const from = Math.max(0, claim.line - 1 - LINE_SLACK);
    const to = Math.min(lines.length, claim.line + LINE_SLACK);
    for (let i = from; i < to; i++) {
      const hay = norm(lines[i]);
      if (hay.length >= MIN_QUOTE && (hay.includes(needle) || needle.includes(hay))) {
        return { verified: true, reason: null, foundAtLine: i + 1 };
      }
    }
  }
  // Multi-line quotes, or a wrong line number: search the whole file.
  if (norm(lines.join(' ')).includes(needle)) {
    const idx = lines.findIndex((l) => norm(l).includes(needle.slice(0, 40)));
    return { verified: true, reason: claim.line != null ? 'other_line' : null, foundAtLine: idx >= 0 ? idx + 1 : null };
  }
  return { verified: false, reason: 'quote_not_found' };
}

/** @returns {{claims, checked, verified, suspect}} */
export function verifyClaims(claims, workdir) {
  const files = new Map();
  const out = claims.map((c) => {
    const r = check(c, workdir, files);
    return { ...c, verified: r.verified, verifyReason: r.reason, verifyNote: r.reason ? REASONS[r.reason] : null, foundAtLine: r.foundAtLine ?? null };
  });
  return {
    claims: out,
    checked: out.length,
    verified: out.filter((c) => c.verified).length,
    suspect: out.filter((c) => SUSPECT.has(c.verifyReason)),
  };
}

export function verificationLine(v) {
  if (!v.checked) return 'no claims to check';
  const parts = [`${v.verified}/${v.checked} claims verified against the files`];
  if (v.suspect.length) parts.push(`${v.suspect.length} point at code that is not there`);
  return parts.join(', ');
}
