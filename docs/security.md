# Security model

## What a specialist can do

Nothing that changes your machine:

- **Codex** runs as `codex exec --sandbox read-only` with `approval_policy=never`, no MCP
  servers, no web search, and your own Codex config, rules and hooks ignored.
- **Antigravity** runs as `agy --mode plan --sandbox`, with no permission-skipping flag,
  so headless mode declines any tool that needs a confirmation.
- Both run in your project directory, with:
  - a hard timeout that kills the whole process tree;
  - an output cap;
  - an environment stripped of anything that looks like a secret (`*KEY*`, `*TOKEN*`,
    `*SECRET*`, ...).
- Every child gets `TANDEM_DEPTH=1`. A tandem server started inside a specialist refuses
  all calls, so specialists can't recurse.
- The prompt goes in on stdin (Codex) or as an argument (Antigravity), never through a
  shell.

## What a specialist sees

Only the packet. Before anything leaves the machine:

- **Paths:**
  - files outside the project are refused;
  - symlinks are resolved, and those leading outside the project are refused;
  - credential files are refused (`.env*`, keys, certificates, `credentials.json`,
    `auth.json`, `.netrc`, ...), and so is anything under `.ssh`, `.aws`, `.gnupg`,
    `.kube`, `.docker`, `.git`, `.codex`, `.gemini`, `.claude`, `.tandem`;
  - binary files and files over the size limit are left out.
- **Content:** token-shaped strings and `password = ...` style assignments are redacted.
- **Workdir:** a filesystem root or a credential directory is refused.

`tandem packet --workdir . --objective "..." --paths a,b` prints the exact packet without
sending it.

Redaction is a safety net, not a guarantee. Don't put secrets in files you ask to have
reviewed.

### Limits of this

- The checks happen before the file is read. Someone who can write to your project while
  tandem runs could swap a file for a link in between. tandem assumes the project
  directory is yours.
- Redaction is pattern-based. It hides key blocks, known token formats and
  `name = value` assignments whose name looks secret. It can't recognise a secret with
  no telltale shape.

## The subagents

The four Claude subagents have a tool allowlist in their frontmatter, plus
`hooks/readonly-guard.mjs` as a second layer. The guard denies:
- writes and redirection;
- command substitution;
- installs and git writes;
- arbitrary scripts;
- anything not on its allowlist.

It fails closed.

The guard is a pattern check, not a sandbox. `sonnet-test-analyst` exists to run your
tests and builds, and those run your project's own code, which can do anything that code
does. Use that subagent only on projects you trust.

## What tandem stores

All local, under `~/.tandem`:
- metadata events;
- cached answers;
- one-line finding summaries per project;
- runtime versions;
- session ids, hashed;
- learning events, which contain the text of the message in which you reported an error.

Delete the folder to remove all of it.

## Installer

- `init` changes nothing you didn't ask for. Hooks and CLAUDE.md are opt-in.
- `settings.json` is backed up before every write, and a file that isn't valid JSON is
  never overwritten.
- Entries are tagged, so `uninstall` removes only tandem's own.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public
issue.
