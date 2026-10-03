// Loads a benchmark set (bench/ for the main set, bench/easy/ for the easy one) and gives
// every sample the same shape, whether its manifest lists one file or several.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH = path.dirname(fileURLToPath(import.meta.url));

export function loadSet(name = 'main') {
  const dir = name === 'easy' ? path.join(BENCH, 'easy') : BENCH;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const samples = manifest.samples.map((s) => ({
    id: s.id || s.file,
    files: s.files || [s.file],
    clean: Boolean(s.clean),
    bug: s.bug || null,
    at: s.at || (s.lines ? [{ file: s.file, lines: s.lines }] : []),
    keywords: s.keywords || [],
  }));
  return { name, dir, corpus: path.join(dir, 'corpus'), results: path.join(dir, 'results'), objective: manifest.objective, samples };
}
