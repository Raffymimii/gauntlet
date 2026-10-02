#!/usr/bin/env node
// gauntlet command line. Run `gauntlet help` for the list.
import fs from 'node:fs';

const HELP = `gauntlet: pair Claude Code with Codex and Gemini

Setup
  gauntlet init [--hooks turn,review-gate] [--claude-md] [--test-analyst] [--force-agents] [--dry-run]
  gauntlet uninstall [--dry-run]
  gauntlet status

Using it
  gauntlet packet --workdir <dir> --objective "<text>" [--paths a,b] [--diff-file f]
        show exactly what a specialist would receive, without sending anything
  gauntlet agent <id> [--workdir <dir>] [--paths a,b] [--objective "<text>"]
                    [--input-file <file>] [--turn <id>] [--event <id>]
        ids: comprehension, anti_hallucination, text_review, jury, legal, learning
  gauntlet stats [--days 30]

Runtime configuration (versioned; open chats pick it up on their next message)
  gauntlet runtime list | show [n] | export [n] | diff <a> <b>
  gauntlet runtime publish <file.json> --reason "<why>"
  gauntlet runtime rollback <n> [--reason "<why>"]
  gauntlet runtime proposals | apply <id> | reject <id>
  gauntlet regress [--only id1,id2] [--agent <id>]
`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
function opt(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const list = (name) => (opt(name) || '').split(',').map((s) => s.trim()).filter(Boolean);
const print = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

function fail(message, code = 1) {
  console.error(`gauntlet: ${message}`);
  process.exitCode = code;
}

async function main() {
  const [cmd, sub, arg] = argv;

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return print(HELP);

    case 'init': {
      const { init } = await import('../src/install.mjs');
      return init({ hooks: list('hooks'), claudeMd: flag('claude-md'), forceAgents: flag('force-agents'), testAnalyst: flag('test-analyst'), dryRun: flag('dry-run') });
    }
    case 'uninstall': {
      const { uninstall } = await import('../src/install.mjs');
      return uninstall({ dryRun: flag('dry-run') });
    }
    case 'status': {
      const { statusReport } = await import('../src/status.mjs');
      return print(await statusReport());
    }

    case 'packet': {
      const { preparePacket } = await import('../src/consult.mjs');
      const { specialistPrompt } = await import('../src/prompts.mjs');
      const p = specialistPrompt('codex_review');
      const diff = opt('diff-file') ? fs.readFileSync(opt('diff-file'), 'utf8') : '';
      const { packet } = preparePacket({ role: p.role, format: p.format, args: { workdir: opt('workdir') || process.cwd(), objective: opt('objective') || '', paths: list('paths'), diff } });
      print(packet.text);
      return console.error(`\n--- ${packet.chars} characters, ${packet.files.length} file(s) embedded${packet.skipped.length ? `, not sent: ${packet.skipped.join('; ')}` : ''}`);
    }

    case 'agent': {
      const { runAgent } = await import('../src/agents.mjs');
      const store = await import('../src/runtime/store.mjs');
      const { AGENT_IDS } = await import('../src/runtime/validate.mjs');
      const id = sub;
      if (!AGENT_IDS.includes(id)) return fail(`agent must be one of: ${AGENT_IDS.join(', ')}`);
      let input = opt('input-file') ? fs.readFileSync(opt('input-file'), 'utf8') : (!process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : '');
      const eventId = opt('event');
      if (id === 'learning' && eventId) {
        const ev = store.readLearningEvent(eventId);
        if (!ev) return fail(`no learning event ${eventId}`);
        input = `USER FEEDBACK (event ${eventId}, runtime v${ev.runtimeVersion}):\n${ev.feedback}\n\nWHAT WENT WRONG, AS REPORTED BY THE ORCHESTRATOR:\n${input}`;
      }
      const snapshot = store.currentRuntime();
      const out = await runAgent({ id, snapshot, input, objective: opt('objective'), workdir: opt('workdir'), paths: list('paths'), turnId: opt('turn') || null });
      if (id === 'learning' && out.ok) {
        const { recordAnalysis } = await import('../src/learning.mjs');
        out.proposals = await recordAnalysis(out.result, { eventId });
      }
      print(out);
      process.exitCode = out.ok ? 0 : 2;
      return;
    }

    case 'regress': {
      const { runAgent } = await import('../src/agents.mjs');
      const { currentRuntime } = await import('../src/runtime/store.mjs');
      const { checkExpectation } = await import('../src/learning.mjs');
      const snapshot = currentRuntime();
      const only = list('only');
      const cases = snapshot.config.regressions
        .filter((c) => !only.length || only.includes(c.id))
        .filter((c) => !opt('agent') || c.agent === opt('agent'));
      let passed = 0;
      for (const c of cases) {
        const out = await runAgent({ id: c.agent, snapshot, input: c.input, objective: `Regression case ${c.id}`, workdir: process.cwd() });
        const r = out.ok ? checkExpectation(c.expect, out.result) : { pass: false, detail: `no answer: ${out.error}` };
        if (r.pass) passed++;
        print(`${r.pass ? 'PASS' : 'FAIL'}  ${c.id}  (${c.agent}, ${out.model ?? '-'}, ${out.durationMs ?? '-'} ms)  ${r.detail}`);
      }
      print(`\n${passed}/${cases.length} passed on runtime v${snapshot.version}`);
      process.exitCode = passed === cases.length ? 0 : 1;
      return;
    }

    case 'runtime':
      return runtimeCommand(sub, arg);

    case 'stats': {
      const { readEvents } = await import('../src/events.mjs');
      const { renderStats } = await import('../src/stats.mjs');
      return print(renderStats(readEvents({ sinceMs: Number(opt('days') || 30) * 86_400_000 })));
    }

    default:
      return fail(`unknown command "${cmd}". Run gauntlet help.`);
  }
}

async function runtimeCommand(sub, arg) {
  const store = await import('../src/runtime/store.mjs');
  switch (sub) {
    case 'list': {
      const cur = store.currentRuntime();
      print(`in force: v${cur.version}${cur.skipped.length ? ` (skipped invalid: ${cur.skipped.map((n) => `v${n}`).join(', ')})` : ''}`);
      for (const v of store.listVersions()) print(`v${v.version}  ${v.publishedAt}  ${v.valid ? '' : '[INVALID] '}${v.rollbackOf != null ? `[rollback of v${v.rollbackOf}] ` : ''}${v.reason ?? ''}`);
      return;
    }
    case 'show':
    case 'export': {
      const snap = arg !== undefined ? store.readVersion(Number(arg)) : store.currentRuntime();
      if (!snap) return fail(`no version ${arg}`);
      return print(sub === 'export' ? snap.config : snap);
    }
    case 'diff': {
      const { diffConfigs } = await import('../src/stats.mjs');
      const a = store.readVersion(Number(arg));
      const b = store.readVersion(Number(argv[3]));
      if (!a || !b) return fail('both versions must exist');
      return print(diffConfigs(a.config, b.config).join('\n') || 'no differences');
    }
    case 'publish': {
      if (!arg) return fail('usage: gauntlet runtime publish <file.json> --reason "<why>"');
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(arg, 'utf8')); } catch (err) { return fail(`cannot read ${arg}: ${err.message}`); }
      const r = await store.publish(cfg, { reason: opt('reason') });
      return r.ok ? print(`published v${r.version}. Open chats use it from their next message.`) : fail(`not published:\n- ${r.errors.join('\n- ')}`);
    }
    case 'rollback': {
      const r = await store.rollback(Number(arg), opt('reason'));
      return r.ok ? print(`published v${r.version} (a copy of v${arg})`) : fail(r.errors.join('; '));
    }
    case 'proposals': {
      const pending = store.listProposals().filter((p) => p.status === 'pending');
      if (!pending.length) return print('no pending proposals');
      for (const p of pending) print(`${p.id}  [${p.risk}] ${p.kind}${p.target_agent ? ` -> ${p.target_agent}` : ''}: ${p.change}${p.lesson ? `\n    lesson: ${p.lesson}` : ''}`);
      return;
    }
    case 'apply': {
      const r = await store.applyProposal(arg);
      return r.ok ? print(`applied as v${r.version}`) : fail(r.errors.join('; '));
    }
    case 'reject': {
      const p = store.readProposal(arg);
      if (p?.status !== 'pending') return fail('no pending proposal with that id');
      store.setProposalStatus(arg, 'rejected', { note: opt('reason') || null });
      return print('rejected');
    }
    default:
      return fail('usage: gauntlet runtime list|show|export|diff|publish|rollback|proposals|apply|reject');
  }
}

try {
  await main();
} catch (err) {
  fail(err.message);
}
