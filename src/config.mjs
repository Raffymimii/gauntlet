// Settings: package defaults, overridden by ~/.gauntlet/config.json (or $GAUNTLET_HOME).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const HOME = process.env.GAUNTLET_HOME
  ? path.resolve(process.env.GAUNTLET_HOME)
  : path.join(os.homedir(), '.gauntlet');

export const PATHS = {
  config: path.join(HOME, 'config.json'),
  cache: path.join(HOME, 'cache'),
  state: path.join(HOME, 'state'),
  events: path.join(HOME, 'events'),
  findings: path.join(HOME, 'findings'),
  runtime: path.join(HOME, 'runtime'),
};

export function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$')) continue; // "$comment" and friends
    const b = base?.[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
      ? deepMerge(b, v)
      : v;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const DEFAULTS = readJson(path.join(PACKAGE_ROOT, 'config', 'default.json'));

/**
 * A broken user file must not take the tool down: fall back to the defaults and say why,
 * so `gauntlet status` can show it.
 */
export function loadConfig(file = PATHS.config) {
  let user = null;
  let error = null;
  try {
    user = readJson(file);
  } catch (err) {
    if (err.code !== 'ENOENT') error = `${file}: ${err.message}`;
  }
  return { ...deepMerge(DEFAULTS, user), _error: error };
}

export const config = loadConfig();
