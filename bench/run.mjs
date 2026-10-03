#!/usr/bin/env node
// Runs the bug-finding benchmark against real models.
//
//   node bench/run.mjs [--set main|easy] [--runs 1] [--lanes codex,gemini,oss,claude] [--only id1,id2]
//
// Every reviewer gets the same prompt (the codex_review one), the same tier and the same
// packet, with fallback switched off: an answer from a different model than the one asked
// is recorded as "no answer" rather than credited to the wrong lane.
// Raw results go to <set>/results/raw-<timestamp>.json; bench/score.mjs scores them.
import fs from 'node:fs';
import path from 'node:path';
import { BENCH, loadSet } from './samples.mjs';

// Keep the benchmark's cache, events and findings memory out of the user's ~/.gauntlet.
process.env.GAUNTLET_HOME = path.join(BENCH, '.home');

const { consult } = await import('../src/consult.mjs');
const { specialistPrompt } = await import('../src/prompts.mjs');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const set = loadSet(arg('set', 'main'));
const lanes = arg('lanes', 'codex,gemini,oss,claude').split(',');
const runs = Number(arg('runs', '1'));
const only = (arg('only', '') || '').split(',').filter(Boolean);
const samples = set.samples.filter((s) => !only.length || only.includes(s.id));
const prompt = specialistPrompt('codex_review');
const HEALTH = path.join(process.env.GAUNTLET_HOME, 'state', 'provider-health.json');
const RETRY_ON = new Set(['provider_error', 'empty_response', 'disabled']);

const results = [];
const started = Date.now();
fs.mkdirSync(set.results, { recursive: true });
const out = path.join(set.results, `raw-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
// Written after every sample, so a run that is stopped halfway still leaves its answers.
const save = () => fs.writeFileSync(out, JSON.stringify({ set: set.name, startedAt: new Date(started).toISOString(), minutes: (Date.now() - started) / 60000, lanes, runs, results }, null, 1));
for (let run = 1; run <= runs; run++) {
  for (const s of samples) {
    // Each sample starts with no paused models: one flaky answer must not knock a reviewer
    // out of every sample after it.
    fs.rmSync(HEALTH, { force: true });
    const answers = await Promise.all(lanes.map(async (lane) => {
      const t0 = Date.now();
      let r;
      let retries = 0;
      for (;;) {
        r = await consult({
          tool: 'bench_review', lane, defaultTier: 'standard', role: prompt.role, format: prompt.format,
          args: { workdir: set.corpus, objective: set.objective, paths: s.files, tier: 'standard', noCache: true },
          crossFamily: false,
        });
        // One more try after a provider hiccup; a second failure counts as no answer.
        if (r.ok || retries >= 1 || !RETRY_ON.has(r.kind)) break;
        retries++;
        fs.rmSync(HEALTH, { force: true });
      }
      const servedBy = r.ok ? r.lane : null;
      return {
        run, id: s.id, lane, retries, ok: r.ok && servedBy === lane, servedBy, model: r.model ?? null,
        ms: Date.now() - t0, error: r.ok ? null : r.kind || 'error',
        usage: r.usage ?? null, verdict: r.json?.verdict ?? null,
        findings: r.ok && r.json ? (r.json.findings || []) : [],
      };
    }));
    for (const a of answers) {
      results.push(a);
      console.log(`run ${run}  ${s.id.padEnd(14)} ${a.lane.padEnd(7)} ${a.ok ? 'ok ' : 'ERR'} ${String(a.findings.length).padStart(2)} findings  ${(a.ms / 1000).toFixed(1)}s  ${a.model ?? a.error}`);
    }
    save();
  }
}
console.log(`\nwrote ${path.relative(process.cwd(), out)}`);
