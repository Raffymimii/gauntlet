// Local event log: one JSON line per specialist or agent call, one file per month, under
// ~/.tandem/events. Metadata only: what ran, on which model, how long, how many tokens.
// Never prompts, file contents or answers. Nothing is sent anywhere; `tandem stats` reads it.
import fs from 'node:fs';
import path from 'node:path';
import { config, PATHS } from './config.mjs';

const FIELDS = new Set([
  'kind', 'tool', 'agent', 'lane', 'model', 'tier', 'status', 'error', 'durationMs', 'cached',
  'packetChars', 'files', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'fallbacks',
  'runtimeVersion', 'turnId', 'verified', 'checked',
]);

function monthFile(ts = Date.now()) {
  return path.join(PATHS.events, `${new Date(ts).toISOString().slice(0, 7)}.jsonl`);
}

export function logEvent(e) {
  if (!config.events.enabled) return;
  const row = { ts: Date.now() };
  for (const [k, v] of Object.entries(e)) if (FIELDS.has(k) && v !== undefined) row[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  try {
    fs.mkdirSync(PATHS.events, { recursive: true });
    fs.appendFileSync(monthFile(), JSON.stringify(row) + '\n', 'utf8');
  } catch { /* logging never breaks a call */ }
}

export function readEvents({ sinceMs = 30 * 86_400_000 } = {}) {
  const since = Date.now() - sinceMs;
  let files = [];
  try { files = fs.readdirSync(PATHS.events).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; }
  const rows = [];
  for (const f of files) {
    if (f.slice(0, 7) < new Date(since).toISOString().slice(0, 7)) continue;
    for (const line of fs.readFileSync(path.join(PATHS.events, f), 'utf8').split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r.ts >= since) rows.push(r); } catch { /* skip */ }
    }
  }
  return rows;
}
