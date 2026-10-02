// A per-project memory of what specialists have flagged, so a report can say
// "seen before, first 12 days ago". Stores the one-line claim and where it pointed,
// never file contents.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from './config.mjs';

const MAX_ROWS = 2000;
const RETAIN_MS = 90 * 86_400_000;

function fileFor(workdir) {
  const abs = path.resolve(workdir);
  const slug = path.basename(abs).replace(/[^\w.-]/g, '_').slice(0, 40) || 'project';
  const hash = crypto.createHash('sha256').update(abs.toLowerCase()).digest('hex').slice(0, 8);
  return path.join(PATHS.findings, `${slug}-${hash}.jsonl`);
}

// Keyed on where it points, not on the wording: two runs describe the same bug
// differently every time.
function keyOf(claim) {
  const file = String(claim.file || '?').replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha256').update(`${file}:${claim.line ?? '?'}`).digest('hex').slice(0, 16);
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Records the claims; returns, per claim, whether the project has seen it before. */
export function remember({ workdir, lane, tool, claims }) {
  const file = fileFor(workdir);
  const previous = new Map(read(file).map((r) => [r.key, r]));
  const now = Date.now();
  const rows = claims.map((c) => {
    const key = keyOf(c);
    const before = previous.get(key);
    return {
      ts: now, key, lane, tool,
      severity: c.severity ?? null, file: c.file ?? null, line: c.line ?? null,
      claim: String(c.claim || '').slice(0, 300),
      verified: Boolean(c.verified),
      firstSeen: before?.firstSeen ?? now,
      timesSeen: (before?.timesSeen ?? 0) + 1,
    };
  });
  if (rows.length) {
    try {
      fs.mkdirSync(PATHS.findings, { recursive: true });
      fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      const all = read(file);
      const keep = all.filter((r) => r.ts >= now - RETAIN_MS).slice(-MAX_ROWS);
      if (keep.length !== all.length) fs.writeFileSync(file, keep.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    } catch { /* memory is a nicety; never fail a call over it */ }
  }
  return rows.map((r) => ({ repeat: r.timesSeen > 1, firstSeen: r.firstSeen }));
}
