#!/usr/bin/env node
// MCP server for Claude Code. Claude stays the only one that writes; these tools hand a
// minimal packet to Codex or Gemini and return their opinion, checked against the files.
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { config } from './config.mjs';
import { consult, header, NESTED } from './consult.mjs';
import { mergeCouncil } from './council.mjs';
import { specialistPrompt, sections, PROMPTS_DIR } from './prompts.mjs';
import { TIERS } from './router.mjs';
import { statusReport } from './status.mjs';


const VERSION = '0.1.0';

const tier = z.enum(['auto', ...TIERS]).optional().describe(
  'light: fast, cheap model for small ordinary questions. standard: normal reviews. deep: flagship models, for security, money, concurrency, production or a hard bug. auto: decided from the size and subject of the packet. Pick the cheapest tier that can do the job.');

const packetShape = {
  workdir: z.string().describe('Absolute path of the project. The specialist reads nothing above it and writes nothing at all.'),
  objective: z.string().describe('What you want decided or found, in one or two sentences. This is the whole task the specialist sees.'),
  constraints: z.array(z.string()).optional().describe('Rules or context to respect: framework version, invariants, what is out of scope.'),
  paths: z.array(z.string()).optional().describe('Project-relative files to include. Keep the list short.'),
  diff: z.string().optional().describe('Unified diff, when the question is about a change.'),
  checks: z.array(z.string()).optional().describe('Specific checks, e.g. "does the retry loop stop on a 429".'),
  tier,
  model: z.string().optional().describe('Pin a model for the first attempt. Usually leave unset and pick a tier.'),
  effort: z.string().optional().describe('Codex reasoning effort override. Usually leave unset.'),
  timeoutMs: z.number().int().min(5000).max(900000).optional().describe('Time budget per attempt.'),
  noCache: z.boolean().optional().describe('Skip the result cache.'),
};

const FOOTER = '\n\n---\nFindings marked as verified were matched against the real files; the rest were not. The specialist cannot and did not change anything.';

function toMcp(r) {
  if (!r.ok) return { isError: true, content: [{ type: 'text', text: r.message }] };
  return { content: [{ type: 'text', text: `${header(r)}\n\n${r.body}${FOOTER}` }] };
}

function planSection(plan) {
  return plan ? `# PLAN UNDER REVIEW\n${plan}` : '';
}

const server = new McpServer(
  { name: 'gauntlet', version: VERSION },
  {
    capabilities: { tools: {} },
    instructions: 'Read-only second opinions from other model families. Send a minimal packet (objective, a few files, the diff, specific checks), never the conversation. Use the cheapest tier that can do the job. Calls fall back automatically when a provider is out of quota.',
  },
);

const SPECIALISTS = [
  ['quick_check', 'gemini', 'light', 'Fast second look at something small: a function, a regex, a query, a config value, a one-file change. Cheap and quick; use it often.'],
  ['codex_review', 'codex', 'auto', 'Adversarial review of a diff or a few files by Codex. Use after any non-trivial change. Returns a verdict and ranked findings with file:line, each checked against the files.'],
  ['gemini_review', 'gemini', 'auto', 'Second review by Gemini, strongest on interface contracts, error paths, state and user-facing regressions.'],
  ['codex_diagnose', 'codex', 'standard', 'Root cause of a bug or failing test. Call it as soon as your first hypothesis fails; give it the symptom, the error output and the few files involved.'],
  ['gemini_analyze', 'gemini', 'standard', 'How a broad or unfamiliar part of the code fits together. Use before editing code you have not read.'],
  ['security_audit', 'codex', 'deep', 'Exploitable issues: injection, authorization gaps, secrets, SSRF, path traversal, races, trust of client input. Use on auth, payments, user input, file paths, shell commands.'],
  ['edge_cases', 'gemini', 'standard', 'Inputs and states the code mishandles, phrased as test cases. Use after writing logic with branches, parsing, dates, money or retries.'],
];

for (const [name, lane, defaultTier, description] of SPECIALISTS) {
  const p = specialistPrompt(name);
  server.registerTool(name, { title: name, description: `${description} Read-only.`, inputSchema: packetShape }, (args) =>
    consult({ tool: name, lane, defaultTier, role: p.role, format: p.format, args }).then(toMcp));
}

const critique = specialistPrompt('plan_critique');
server.registerTool('plan_critique', {
  title: 'plan_critique',
  description: 'Critique of an implementation plan before any code is written: wrong assumptions, missing steps, simpler paths, production risks. Use on any task that touches more than one file. Read-only.',
  inputSchema: { ...packetShape, plan: z.string().describe('The plan: steps, files to touch, approach, assumptions.') },
}, (args) => consult({ tool: 'plan_critique', lane: 'codex', defaultTier: 'standard', role: critique.role, format: critique.format, args, extra: planSection(args.plan) }).then(toMcp));

const councilRoles = sections(path.join(PROMPTS_DIR, 'specialists', 'council.md'));
const MODE_FORMAT = { review: 'codex_review', diagnose: 'codex_diagnose', critique: 'plan_critique' };

server.registerTool('council', {
  title: 'council',
  description: 'The same question to Codex, Gemini and GPT-OSS in parallel, merged: each verdict, the findings two or more families agree on (the strongest signal), and where they disagree. Use for risky changes, security-sensitive code or a design you are unsure of. Read-only.',
  inputSchema: {
    ...packetShape,
    lanes: z.array(z.enum(['codex', 'gemini', 'oss'])).min(2).max(3).optional().describe('Which families sit on the council. Default: all three.'),
    mode: z.enum(['review', 'diagnose', 'critique']).optional().describe('Default review.'),
    plan: z.string().optional().describe('For mode=critique: the plan.'),
  },
}, async (args) => {
  const lanes = [...new Set(args.lanes?.length ? args.lanes : ['codex', 'gemini', 'oss'])];
  if (lanes.length < 2) return { isError: true, content: [{ type: 'text', text: 'A council needs at least two different families.' }] };
  const mode = args.mode || 'review';
  const format = specialistPrompt(MODE_FORMAT[mode]).format;
  const extra = mode === 'critique' ? planSection(args.plan) : '';
  const results = await Promise.all(lanes.map((lane) => consult({
    tool: `council_${mode}`, lane, defaultTier: 'standard', role: councilRoles[lane], format, args, crossFamily: false, extra,
  })));
  const text = mergeCouncil(results, { header, mode });
  return results.some((r) => r.ok)
    ? { content: [{ type: 'text', text: text + FOOTER }] }
    : { isError: true, content: [{ type: 'text', text }] };
});

server.registerTool('gauntlet_status', {
  title: 'gauntlet_status',
  description: 'Which CLIs are installed and signed in, which model each tier uses, which models are paused after failures, and the limits in force. Call it after a failed call. Never shows credentials.',
  inputSchema: {},
}, async () => ({ content: [{ type: 'text', text: await statusReport() }] }));

await server.connect(new StdioServerTransport());
if (NESTED) process.stderr.write('gauntlet: running inside a specialist; calls will be refused\n');
if (config._error) process.stderr.write(`gauntlet: config error, using defaults: ${config._error}\n`);
