// Every test process gets its own GAUNTLET_HOME, set before any src module loads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-test-'));
process.env.GAUNTLET_HOME = path.join(TMP, 'home');

export function project(files) {
  const dir = fs.mkdtempSync(path.join(TMP, 'proj-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
