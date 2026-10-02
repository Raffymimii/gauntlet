#!/usr/bin/env node
// PreToolUse guard for the read-only subagents in claude/agents.
//
// The tool allowlist in each agent's frontmatter is the first barrier; this is the second,
// and the only one that can look inside a Bash command. It fails closed: anything it
// cannot parse is denied. Exit code 2 blocks the call; the reason goes to stderr.
import { readFileSync } from 'node:fs';

const deny = (reason) => { process.stderr.write(`readonly-guard: ${reason}`); process.exit(2); };
const allow = () => process.exit(0);

let input;
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { deny('could not parse the hook input, so the call is denied.'); }

const tool = input.tool_name || '';
const command = String(input.tool_input?.command ?? '');

if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) deny(`${tool} is not available to a read-only subagent. Report the change and let the main session make it.`);
if (/^(Task|Agent)$/.test(tool)) deny('a subagent may not start further agents. Return your findings instead.');
if (tool !== 'Bash') allow();
if (!command.trim()) deny('empty command.');

const CONSTRUCTS = [[/>>?[^&]/, 'output redirection'], [/\$\(/, 'command substitution'], [/`/, 'backticks'], [/<\(/, 'process substitution'], [/\beval\b/, 'eval'], [/\bexec\b/, 'exec']];
for (const [re, label] of CONSTRUCTS) if (re.test(command)) deny(`${label} is not allowed here. Use a plain read-only command.`);

// awk, sed and tree are left out on purpose: each can write files or run commands
// (awk's system(), sed's w and e commands, tree -o). The subagents have Read and Grep.
const ALLOWED = new Set([
  'npm', 'pnpm', 'yarn', 'npx', 'bun', 'jest', 'vitest', 'mocha', 'tsc', 'tsx', 'eslint', 'prettier', 'biome',
  'pytest', 'python', 'python3', 'ruff', 'flake8', 'mypy', 'go', 'cargo', 'dotnet', 'mvn', 'gradle', './gradlew', 'make',
  'git', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'sort', 'uniq', 'cut', 'diff', 'stat',
  'file', 'pwd', 'which', 'echo', 'jq', 'node',
]);

const MUTATING = [
  [/^npm\s+(i|install|ci|publish|link|update|uninstall|remove|run\s+(deploy|release|publish|start))\b/, 'npm install, publish or deploy'],
  [/^(pnpm|yarn|bun)\s+(add|install|remove|publish|up|upgrade|link)\b/, 'package installation'],
  [/^python3?\s+-m\s+pip\b/, 'pip'],
  [/^go\s+(install|get|mod\s+(tidy|download|edit))\b/, 'go module changes'],
  [/^cargo\s+(install|publish|add|remove|update|fix)\b/, 'cargo changes'],
  [/^dotnet\s+(add|remove|publish|nuget|restore)\b/, 'dotnet changes'],
  [/^git\s+(?!status|log|diff|show|rev-parse|branch\s*$|branch\s+-[avr]|describe|blame|ls-files|ls-tree|remote\s+-v|shortlog|cat-file|merge-base)/, 'a git command that can change the repository'],
  [/^(npx|bunx)\s+(?!tsc|eslint|prettier|vitest|jest|biome|tsx)/, 'an arbitrary npx package'],
  [/^node\s+(?!--version\b|-v\b|--check\b|--test\b)/, 'running an arbitrary node script'],
  [/^python3?\s+(?!--version|-V|-m\s+(pytest|mypy|ruff|flake8|unittest))/, 'running an arbitrary python script'],
  [/^find\s+.*-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/, 'find with a mutating action'],
  [/^sort\b.*\s(-o|--output)/, 'sort writing to a file'],
  [/^git\s+.*--output/, 'git writing to a file'],
];

// A single & runs the next command in the background, so it separates commands too.
// Stream merges like 2>&1 are harmless and taken out first.
for (const raw of command.replace(/\d?>&\d/g, ' ').split(/(?:&&|\|\||[|;&\n])+/).map((s) => s.trim()).filter(Boolean)) {
  // Quotes around the program name ("node" -e ...) must not slip past the checks below.
  const seg = raw.replace(/^(["'])([^"']+)\1/, '$2');
  const head = (seg.match(/^\S+/) || [''])[0];
  if (!ALLOWED.has(head)) deny(`"${head}" is not on the allowlist. Tests, linters, type-checks, builds and read-only inspection only.`);
  for (const [re, label] of MUTATING) if (re.test(seg)) deny(`${label} can change state. Describe the change and let the main session make it.`);
}
allow();
