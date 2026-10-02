// Result cache. The key covers the tool, tier, model and the exact bytes of every file in
// the packet, so asking the same question about unchanged code costs nothing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, PATHS } from './config.mjs';

export function cacheKey(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function cacheGet(key) {
  if (!config.cache.enabled) return null;
  const file = path.join(PATHS.cache, `${key}.json`);
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - entry.ts > config.cache.ttlMs) { fs.unlinkSync(file); return null; }
    return entry.value;
  } catch {
    return null;
  }
}

export function cacheSet(key, value) {
  if (!config.cache.enabled) return;
  try {
    fs.mkdirSync(PATHS.cache, { recursive: true });
    fs.writeFileSync(path.join(PATHS.cache, `${key}.json`), JSON.stringify({ ts: Date.now(), value }), 'utf8');
    const entries = fs.readdirSync(PATHS.cache).filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(PATHS.cache, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of entries.slice(config.cache.maxEntries)) fs.unlinkSync(path.join(PATHS.cache, f));
  } catch { /* best effort */ }
}

export function cacheSize() {
  try { return fs.readdirSync(PATHS.cache).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}
