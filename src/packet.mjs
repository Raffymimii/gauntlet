// The task packet: the only thing a specialist ever sees.
//
// Role, objective, constraints, the files and diff that matter, the checks wanted and the
// answer format. Never the Claude conversation. Files are embedded so the specialist can
// answer without tools; everything is redacted on the way out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { redact, isForbiddenPath } from './redact.mjs';

export class PacketError extends Error {}

const CREDENTIAL_DIR = /[\\/]\.(ssh|gnupg|aws|azure|kube|codex|gemini|claude|tandem)([\\/]|$)/i;

export function resolveWorkdir(workdir) {
  if (!workdir || typeof workdir !== 'string') throw new PacketError('workdir is required: the absolute path of the project');
  let abs;
  try { abs = fs.realpathSync(path.resolve(workdir)); } catch { throw new PacketError(`workdir does not exist: ${workdir}`); }
  if (!fs.statSync(abs).isDirectory()) throw new PacketError(`workdir is not a directory: ${abs}`);
  if (abs === path.parse(abs).root) throw new PacketError('workdir must be a project directory, not a filesystem root');
  if (CREDENTIAL_DIR.test(abs)) throw new PacketError(`workdir is inside a credential directory and is refused: ${abs}`);
  return abs;
}

export function inside(abs, root) {
  const rel = path.relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

const BASE_CONSTRAINTS = [
  'You are an advisory, read-only reviewer. Do not write, create, move, delete or patch any file.',
  'Do not run mutating commands, install packages, change git state or use the network.',
  'Do not hand this task to another agent.',
  // Also a reliability measure: in headless mode a specialist that reaches for a tool
  // gets refused and may return nothing at all.
  'Answer from the material in this packet alone. Do not use tools, open files or run commands: everything you need is here.',
  'Ground every claim in the material. Quote the exact source line you mean: quotes are checked against the file, and a claim whose quote is not there is reported as unverified.',
  'If the material is not enough, say exactly what is missing instead of guessing.',
];

/**
 * @returns {{text, chars, contentHash, skipped: string[], truncated: boolean, files: string[]}}
 */
export function buildPacket({ role, objective, constraints = [], paths = [], diff = '', checks = [], format, workdir, extra = '', maxChars }) {
  const L = config.limits;
  const cap = maxChars || L.maxPacketChars;
  if (typeof objective !== 'string' || objective.trim().length < 8) throw new PacketError('objective is required and must describe the task');
  if (paths.length > L.maxPathsPerCall) throw new PacketError(`too many paths (${paths.length} > ${L.maxPathsPerCall}); narrow the request`);

  const hash = crypto.createHash('sha256');
  const sections = [`# ROLE\n${role}`, `# OBJECTIVE\n${redact(objective.trim())}`];
  const allConstraints = [...BASE_CONSTRAINTS, ...constraints.map(String)];
  sections.push(`# CONSTRAINTS\n${allConstraints.map((c) => `- ${redact(c)}`).join('\n')}`);
  if (checks.length) sections.push(`# REQUESTED CHECKS\n${checks.map((c) => `- ${redact(String(c))}`).join('\n')}`);

  if (diff) {
    // Redact first, then cut: a cut through the middle of a key block must not leave it
    // unrecognisable to the redactor.
    let d = redact(String(diff));
    if (d.length > L.maxDiffChars) d = `${d.slice(0, L.maxDiffChars)}\n[diff cut at ${L.maxDiffChars} characters]`;
    hash.update(`diff:${d}`);
    sections.push(`# DIFF UNDER REVIEW\n\`\`\`diff\n${d}\n\`\`\``);
  }

  const skipped = [];
  const files = [];
  const chunks = [];
  for (const p of paths) {
    const abs = path.resolve(workdir, p);
    const rel = path.relative(workdir, abs).split(path.sep).join('/');
    if (!inside(abs, workdir)) { skipped.push(`${p} (outside the project)`); continue; }
    if (isForbiddenPath(rel)) { skipped.push(`${rel} (credential-bearing path, refused)`); continue; }
    let real;
    try { real = fs.realpathSync(abs); } catch { skipped.push(`${rel} (not found)`); continue; }
    // A symlink must not lead outside the project, nor to a credential file inside it
    // (review.txt -> .env).
    if (real !== workdir && !inside(real, workdir)) { skipped.push(`${rel} (symlink leading outside the project, refused)`); continue; }
    if (isForbiddenPath(path.relative(workdir, real))) { skipped.push(`${rel} (points at a credential-bearing path, refused)`); continue; }
    const st = fs.statSync(real);
    if (st.isDirectory()) { chunks.push(`## ${rel}/ (directory, not embedded)`); hash.update(`dir:${rel}`); continue; }
    if (st.size > L.maxFileBytes) { skipped.push(`${rel} (${st.size} bytes, over the ${L.maxFileBytes}-byte limit)`); continue; }
    const buf = fs.readFileSync(real);
    if (looksBinary(buf)) { skipped.push(`${rel} (binary)`); continue; }
    const body = buf.toString('utf8');
    hash.update(`file:${rel}:${crypto.createHash('sha256').update(buf).digest('hex')}`);
    files.push(rel);
    chunks.push(`## ${rel}\n\`\`\`${path.extname(rel).slice(1) || 'text'}\n${redact(body)}\n\`\`\``);
  }
  if (chunks.length) sections.push(`# RELEVANT FILES\n${chunks.join('\n\n')}`);
  if (skipped.length) sections.push(`# NOT INCLUDED\n${skipped.map((s) => `- ${s}`).join('\n')}`);

  if (extra) {
    hash.update(`extra:${extra}`);
    sections.push(redact(extra));
  }
  sections.push(`# RESPONSE FORMAT\n${format}`);

  let text = sections.join('\n\n');
  let truncated = false;
  if (text.length > cap) {
    text = `${text.slice(0, cap)}\n\n[packet cut at ${cap} characters: narrow the request]`;
    truncated = true;
  }
  hash.update(`shape:${role}|${objective}|${allConstraints.join('|')}|${checks.join('|')}|${format}`);

  return { text, chars: text.length, contentHash: hash.digest('hex'), skipped, truncated, files };
}
