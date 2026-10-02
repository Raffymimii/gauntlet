// Prompts live in prompts/ as markdown, so people can read and change them without
// touching code. A file is split on its "## name" headings.
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from './config.mjs';

export const PROMPTS_DIR = path.join(PACKAGE_ROOT, 'prompts');

export function sections(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const out = {};
  let name = null;
  let buf = [];
  const flush = () => { if (name) out[name] = buf.join('\n').trim(); };
  for (const line of text.split('\n')) {
    const m = line.match(/^## +(.+?)\s*$/);
    if (m) { flush(); name = m[1].toLowerCase(); buf = []; } else if (name) buf.push(line);
  }
  flush();
  return out;
}

export function specialistPrompt(tool) {
  const s = sections(path.join(PROMPTS_DIR, 'specialists', `${tool}.md`));
  if (!s.role || !s.format) throw new Error(`prompts/specialists/${tool}.md needs "## Role" and "## Format" sections`);
  return s;
}

export function agentPrompt(id) {
  return fs.readFileSync(path.join(PROMPTS_DIR, 'agents', `${id}.md`), 'utf8').replace(/\r\n/g, '\n').replace(/^# .*\n+/, '').trim();
}
