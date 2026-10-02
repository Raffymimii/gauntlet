# tandem

**Second opinions for Claude Code from Codex and Gemini, using the subscriptions you already pay for.**

tandem is an MCP server plus a few hooks. Claude keeps doing the work and stays the only
one that edits your files. When a change matters, it hands a small, focused packet to a
model from another family (OpenAI's Codex CLI, or Gemini through Google's Antigravity
CLI) and gets back a structured review. Before Claude reads that review, every finding is
checked against your real files.

```
you ──► Claude Code (writes the code)
             │  "review this diff"           ▲  verdict + findings,
             ▼                               │  each one checked against the file
        tandem MCP server ──► Codex CLI / Antigravity CLI (read-only sandbox)
```

## Why

- **Different models miss different things.** A reviewer from another family catches
  what the author's own model would defend. The `council` tool asks three families at
  once and tells you which findings two of them reached independently, which is the
  strongest signal you can get without a human.
- **Hallucinated findings get caught mechanically.** Specialists must quote the exact
  line they're talking about. tandem looks for that quote in the file, so a confident
  finding about code that doesn't exist shows up under "could not be confirmed" instead
  of sending Claude on a wild goose chase.
- **It spends your Claude quota where it matters.** See [docs/token-savings.md](docs/token-savings.md).
  Reviews, diagnoses and edge-case hunting run on your ChatGPT and Google plans, with
  small packets instead of your whole conversation, at the cheapest tier that can do the
  job, and cached on unchanged code.
- **It doesn't fall over.** When a model is out of quota, the call moves to the next one:
  a smaller model of the same family, then another family, then Claude through
  Antigravity. The failing model is paused for a while so later calls skip it at once.
- **No API keys, no extra bills.** It drives the official CLIs on your existing logins.

## What you get

**MCP tools** (all read-only):

| Tool | Default model | Use it for |
|---|---|---|
| `quick_check` | Gemini, light | a fast look at a function, regex, query or config |
| `codex_review` | Codex, auto | adversarial review of a diff or a few files |
| `gemini_review` | Gemini, auto | second review: contracts, error paths, state, UX |
| `codex_diagnose` | Codex, standard | root cause of a bug or failing test |
| `gemini_analyze` | Gemini, standard | how unfamiliar code fits together |
| `plan_critique` | Codex, standard | a plan, before any code is written |
| `security_audit` | Codex, deep | exploitable issues |
| `edge_cases` | Gemini, standard | inputs the code mishandles, as test cases |
| `council` | Codex + Gemini + GPT-OSS | the same question to three families, merged |
| `tandem_status` | none | what's installed, signed in, paused |

**Subagents** for Claude Code: `haiku-navigator` (find things), `sonnet-reviewer` (review
when other providers are down), `sonnet-test-analyst` (run and read tests; opt-in),
`opus-architect` (plan big changes). All are read-only, enforced by a guard hook.

**Optional hooks:**

- `turn` runs before each message. It loads a versioned runtime configuration and, for
  long multi-part requests, a comprehension pass. See [Runtime](#runtime).
- `review-gate` blocks `git push` and deploy commands while edited code has had no
  outside review. Append `# review-skip: <reason>` to the command for trivial changes.

**Internal agents** (comprehension, anti-hallucination, text review, jury, legal,
learning). Claude runs them through `tandem agent` when a turn needs them.

## Requirements

- Node.js 20 or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code)
- At least one of:
  - **Codex CLI**, signed in with a ChatGPT plan (`codex login`)
  - **Antigravity CLI** (`agy`), signed in with a Google account that has Gemini
    access. This also serves GPT-OSS and the Claude fallback lane.

With only one of them installed, tandem uses that one. With neither, you still get the
Claude subagents.

## Install

```bash
git clone https://github.com/<you>/claude-tandem.git
cd claude-tandem
npm install
node bin/tandem.mjs init --dry-run      # see what it would change
node bin/tandem.mjs init                # MCP server + subagents
node bin/tandem.mjs status              # check providers and logins
```

By default `init` registers the MCP server (through `claude mcp add`) and installs the
subagents. You can also opt in to these:

```bash
node bin/tandem.mjs init --claude-md            # add the working rules to ~/.claude/CLAUDE.md
node bin/tandem.mjs init --hooks turn,review-gate
node bin/tandem.mjs init --test-analyst         # the subagent that runs your tests (runs project code)
```

Before writing `~/.claude/settings.json`, `init` makes a backup. Every entry it adds is
tagged, so `tandem uninstall` removes exactly those entries and nothing else.

**Open a new Claude Code chat afterwards.** MCP servers and CLAUDE.md are read when a
chat starts.

To use `tandem` as a plain command, run `npm link` in the folder. The examples here use
`node bin/tandem.mjs` so they work either way.

## Runtime

The six internal agents, the routing thresholds and the policy Claude follows live in a
**versioned runtime configuration** under `~/.tandem/runtime/versions/`. Because the
`turn` hook reads it on every message, a version you publish applies to chats that are
already open, from their next message, without restarting them or losing history.

```bash
tandem runtime export > my.json        # current config
# edit my.json: a prompt, a threshold, disable an agent...
tandem runtime publish my.json --reason "stricter text review"
tandem runtime list
tandem runtime rollback 3              # republishes v3 as a new version
tandem regress                         # run the regression cases against real models
```

When you tell Claude it got something wrong, the hook opens a **learning event**. The
learning agent proposes fixes: lessons for an agent's prompt, new regression cases,
routing changes. Only regression cases that pass strict validation are applied
automatically, because adding a check can't change behaviour. Lessons and prompt changes
wait for you: `tandem runtime proposals`, then `apply <id>` or `reject <id>`. No model is
ever fine-tuned; "learning" means versioned configuration you can read, diff and roll
back.

## Privacy and security

- A specialist gets a **packet**: objective, constraints, the files you name, the diff,
  the checks. It never gets the conversation. Run `tandem packet` to see exactly what
  would be sent.
- These are never sent:
  - credential files (`.env*`, keys, `.ssh`, `.aws`, ...);
  - symlinks that lead outside the project;
  - binaries;
  - anything outside the project.

  Token-shaped strings are redacted from what does go.
- Provider CLIs run read-only (`codex exec --sandbox read-only`, `agy --mode plan
  --sandbox`), in your project directory, with a scrubbed environment and a hard
  timeout.
- A specialist can't call further specialists.
- What goes to OpenAI or Google is governed by **your** agreement with them. With
  `fallback.crossFamily` on (the default), a call can move from one provider to the
  other when the first is unavailable. Turn it off, or turn off a lane, in
  `~/.tandem/config.json`.
- Local data (event log, cache, findings memory, runtime versions) stays in
  `~/.tandem`. Nothing is sent anywhere else.

More in [docs/security.md](docs/security.md).

## Configuration

`~/.tandem/config.json` overrides [config/default.json](config/default.json):
- model names per tier;
- which lanes are on;
- limits;
- cache.

Model names change often, so this is the file to edit when a provider renames one. See
[docs/configuration.md](docs/configuration.md).

## Docs

- [How it works](docs/architecture.md)
- [Token savings: what they are and how to measure them](docs/token-savings.md)
- [Security model](docs/security.md)
- [Configuration](docs/configuration.md)

## Using it with your providers' terms

tandem automates the official command-line tools under your own accounts. Check that the
way you use them fits the terms of your plans with OpenAI and Google. tandem doesn't share
accounts, bypass limits or resell access, and it backs off when a provider says you're out
of quota.

## License

MIT
