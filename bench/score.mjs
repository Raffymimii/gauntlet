#!/usr/bin/env node
// Scores a benchmark run: node bench/score.mjs [--set main|easy] [raw file]
//
// A seeded bug counts as found when a finding points within two lines of the bug, in the
// right file, AND its text names the problem (one of the manifest's keywords). A comment
// that merely lands near the bug doesn't count. On the bug-free files every high or medium
// finding is a false alarm. A finding whose quoted code is not in the file (checked with
// src/verify.mjs, the same check Gauntlet runs) is a made-up finding.
//
// "Gauntlet council" is Codex + Gemini + GPT-OSS answering the same question, scored two
// ways: a bug counts if any family found it, or only if two or more did.
import fs from 'node:fs';
import path from 'node:path';
import { BENCH, loadSet } from './samples.mjs';

process.env.GAUNTLET_HOME = path.join(BENCH, '.home');
const { verifyClaims, SUSPECT } = await import('../src/verify.mjs');

const argv = process.argv.slice(2);
const setName = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : 'main';
const set = loadSet(setName);
const explicit = argv.find((a) => a.endsWith('.json'));
// Every raw file in the results folder is one batch of runs; they are scored together, with
// the runs renumbered so each keeps its own identity.
const rawFiles = explicit ? [explicit] : fs.readdirSync(set.results).filter((f) => f.startsWith('raw-')).sort().map((f) => path.join(set.results, f));
const raws = rawFiles.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
let offset = 0;
const raw = { lanes: raws[0].lanes, startedAt: raws[0].startedAt, minutes: 0, results: [] };
for (const r of raws) {
  const runIds = [...new Set(r.results.map((a) => a.run))];
  for (const a of r.results) raw.results.push({ ...a, run: offset + runIds.indexOf(a.run) + 1 });
  offset += runIds.length;
  raw.minutes += r.minutes;
}
const rawPath = rawFiles.map((f) => path.basename(f)).join(', ');

const byId = new Map(set.samples.map((s) => [s.id, s]));
const buggy = set.samples.filter((s) => !s.clean);
const clean = set.samples.filter((s) => s.clean);
const COUNCIL = ['codex', 'gemini', 'oss'].filter((l) => raw.lanes.includes(l));
// Labels come from the model that actually answered, so a run is never mislabelled.
const PRETTY = [
  [/^gpt-oss-120b/, 'GPT-OSS 120B'], [/^gpt-5.6-terra/, 'Codex GPT-5.6 Terra'], [/^gpt-5.6-luna/, 'Codex GPT-5.6 Luna'],
  [/^gemini-3.8-flash/, 'Gemini 3.8 Flash'], [/^claude-sonnet-5-5/, 'Claude Sonnet 5.5'], [/^claude-sonnet-4-6/, 'Claude Sonnet 4.6'],
];
const laneName = (lane) => {
  const counts = {};
  for (const a of raw.results) if (a.lane === lane && a.ok && a.model) counts[a.model] = (counts[a.model] || 0) + 1;
  const model = Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0];
  return PRETTY.find(([re]) => re.test(model || ''))?.[1] || model || lane;
};
const NAMES = Object.fromEntries(['claude', 'codex', 'gemini', 'oss'].map((l) => [l, laneName(l)]));
const LINE_SLACK = 2;

const norm = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
const text = (f) => `${f.claim || ''} ${f.fix || ''} ${f.evidence || ''}`.toLowerCase();

function hits(sample, f) {
  // The line where the quoted code really is, when the check found it; otherwise the stated one.
  const line = f.foundAtLine ?? f.line;
  if (line == null) return false;
  const near = sample.at.some((a) => norm(a.file) === norm(f.file) && a.lines.some((l) => Math.abs(line - l) <= LINE_SLACK));
  return near && sample.keywords.some((k) => text(f).includes(k.toLowerCase()));
}

const answers = raw.results.map((a) => {
  const s = byId.get(a.id || a.file);
  const findings = a.findings.map((f) => ({ ...f, file: f.file || s.files[0] }));
  const v = verifyClaims(findings, set.corpus);
  return { ...a, id: s.id, sample: s, findings: v.claims.map((c) => ({ ...c, suspect: SUSPECT.has(c.verifyReason), hit: !s.clean && hits(s, c) })) };
});

const runs = [...new Set(answers.map((a) => a.run))].sort();
const median = (xs) => { const v = [...xs].sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const answer = (run, lane, id) => answers.find((a) => a.run === run && a.lane === lane && a.id === id);

function scoreGroup(lanes, minVotes) {
  return runs.map((run) => {
    let found = 0;
    for (const s of buggy) {
      const votes = lanes.filter((l) => answer(run, l, s.id)?.findings.some((f) => f.hit)).length;
      if (votes >= minVotes) found++;
    }
    let falseAlarms = 0;
    for (const s of clean) {
      const serious = lanes.map((l) => (answer(run, l, s.id)?.findings || []).filter((f) => f.severity === 'high' || f.severity === 'medium'));
      if (minVotes <= 1) {
        falseAlarms += serious.reduce((n, list) => n + list.length, 0);
      } else {
        // An alarm survives only if another family flagged the same spot (within 3 lines).
        const spots = [];
        serious.forEach((list, i) => list.forEach((f) => {
          const agreeing = serious.filter((other, j) => j !== i && other.some((g) => norm(g.file) === norm(f.file) && g.line != null && f.line != null && Math.abs(g.line - f.line) <= 3)).length;
          if (agreeing + 1 >= minVotes && !spots.some((p) => p.file === norm(f.file) && Math.abs(p.line - f.line) <= 3)) spots.push({ file: norm(f.file), line: f.line });
        }));
        falseAlarms += spots.length;
      }
    }
    const all = lanes.flatMap((l) => answers.filter((a) => a.run === run && a.lane === l));
    const findings = all.flatMap((a) => a.findings);
    // The council's wall time per sample is its slowest voice.
    const wall = minVotes >= 1 && lanes.length > 1
      ? set.samples.map((s) => Math.max(...lanes.map((l) => answer(run, l, s.id)?.ms ?? 0)))
      : all.filter((a) => a.ok).map((a) => a.ms);
    return {
      found, falseAlarms, findings: findings.length, madeUp: findings.filter((f) => f.suspect).length,
      failed: all.filter((a) => !a.ok).length, ms: wall,
      tokensIn: all.map((a) => a.usage?.inputTokens).filter(Number.isFinite),
    };
  });
}

function summarise(label, lanes, minVotes) {
  const per = scoreGroup(lanes, minVotes);
  return {
    label, lanes, minVotes,
    found: per.map((p) => p.found), foundMean: mean(per.map((p) => p.found)),
    falseAlarms: per.map((p) => p.falseAlarms), falseAlarmsMean: mean(per.map((p) => p.falseAlarms)),
    findings: per.reduce((n, p) => n + p.findings, 0), madeUp: per.reduce((n, p) => n + p.madeUp, 0),
    failed: per.reduce((n, p) => n + p.failed, 0),
    medianSeconds: median(per.flatMap((p) => p.ms)) / 1000,
    medianTokensIn: median(per.flatMap((p) => p.tokensIn)),
  };
}

const rows = [
  ...Object.keys(NAMES).filter((l) => raw.lanes.includes(l)).map((l) => summarise(NAMES[l], [l], 1)),
  summarise('Gauntlet council, any family', COUNCIL, 1),
  summarise('Gauntlet council, 2+ families agree', COUNCIL, 2),
  // How it's actually used: Claude writes the code and reads the council, so its own review
  // is one of the votes.
  ...(raw.lanes.includes('claude') ? [summarise('Claude + Gauntlet council, 2+ of 4 agree', [...COUNCIL, 'claude'], 2)] : []),
];

const perBug = buggy.map((s) => ({
  id: s.id, bug: s.bug,
  found: Object.fromEntries(raw.lanes.map((l) => [l, runs.filter((run) => answer(run, l, s.id)?.findings.some((f) => f.hit)).length])),
}));

const summary = { set: set.name, source: path.basename(rawPath), startedAt: raw.startedAt, minutes: raw.minutes, runs: runs.length, buggy: buggy.length, clean: clean.length, rows, perBug };
fs.writeFileSync(path.join(set.results, 'summary.json'), JSON.stringify(summary, null, 1));

const fmt = (x) => (x == null ? '-' : Number.isInteger(x) ? String(x) : x.toFixed(1));
console.log(`${set.name} set: ${runs.length} run(s), ${buggy.length} seeded bugs, ${clean.length} clean files\n`);
console.log(`| Reviewer | Bugs found (of ${buggy.length}) | False alarms per run | Made-up findings | No answer | Median time |`);
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.label} | ${fmt(r.foundMean)} (runs: ${r.found.join(', ')}) | ${fmt(r.falseAlarmsMean)} | ${r.madeUp} of ${r.findings} | ${r.failed} | ${fmt(r.medianSeconds)} s |`);
}
console.log('\nPer bug (runs that found it):');
for (const b of perBug) console.log(`${b.id.padEnd(14)} ${Object.entries(b.found).map(([l, n]) => `${l}:${n}`).join('  ')}`);
