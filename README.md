<div align="center">

# Gauntlet

**Make Claude's code run the gauntlet.**

Codex, Gemini and GPT-OSS review what Claude Code writes, and every finding has to quote
the line it's about. Gauntlet checks those quotes against your files before Claude reads a word.

It uses the ChatGPT and Google subscriptions you already have. No API keys, no extra bill.

[![CI](https://github.com/Raffymimii/gauntlet/actions/workflows/ci.yml/badge.svg)](https://github.com/Raffymimii/gauntlet/actions/workflows/ci.yml)
![Node 20+](https://img.shields.io/badge/node-20%2B-339933)
![MCP](https://img.shields.io/badge/MCP-server-6E56CF)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## The problem

You ask an AI to review the code an AI just wrote, and two things go wrong.

1. **It shares the author's blind spots.** Ask the same model to "review carefully" and it
   tends to defend its own choices. The bug it didn't see while writing, it doesn't see
   while reviewing either.
2. **It invents findings.** A reviewer model will tell you, in confident prose, about a
   race condition on line 84, and line 84 is a comment. You lose a turn chasing it, or
   worse, you "fix" working code.

## What Gauntlet does

Claude keeps writing the code and stays the only one that touches your files. When a
change matters, Claude sends a small, focused packet to a model from **another family**
and gets back a structured review. **Before Claude reads that review, each finding's
quoted line is looked up in the real file.**

Here is real output from Gauntlet reviewing its own JSON parser. Two families were
asked; one approved, and the other found two real bugs, both quoted from the file:

```text
# Council (review): 2/2 voices answered

## Verdicts
- codex (gpt-5.6-terra): approve, confidence high
- gemini (gemini-3.8-flash-high): approve_with_changes, confidence high

Disagreement: approve vs approve_with_changes. Resolve it with evidence, not by averaging.

## gemini
[gemini / gemini-3.8-flash-high, advisory and read-only: tier standard, 108.4s,
 2/2 claims verified against the files]

## Findings verified against the files (2)
1. [medium] src/json.mjs:32: extractJson aborts on the first unclosed opening brace,
   failing to extract subsequent valid JSON objects.
   Fix: Replace `break;` with `continue;` ...
2. [low] src/json.mjs:28: extractJson returns arrays when the input is a standalone
   JSON array ...
```

Both were fixed in the next commit. A finding whose quote *isn't* in the file lands in a
separate section, **"could not be confirmed"**, so you can tell real findings from
invented ones at a glance.

## Why it works

**Different families, not different prompts.** OpenAI, Google and open-weight models are
trained differently and fail differently. Gauntlet's `council` asks up to three of them at
once and tells you which findings **two families reached independently**: the strongest
signal you can get short of a human reviewer.

**Receipts or it didn't happen.** Every finding must quote its line verbatim. Gauntlet
looks for the quote within a few lines of where the model says it is, then in the whole
file. "Verified", "not checkable" and "could not be confirmed" are separate sections, and
the check costs nothing because no model is involved.

**Your Claude quota stays with Claude.** Reviews run on your ChatGPT and Google plans, on
packets of a few thousand characters instead of your whole conversation, at the cheapest
tier that can do the job, and they're cached on unchanged code. See
[how the savings work and how to measure them](docs/token-savings.md).

**It doesn't get stuck.** When a model is out of quota, the call moves along a chain: a
smaller model of the same family, then another family, then Claude through Antigravity.
The failing model is paused so the next call skips it at once. We tested it by breaking
Codex, then Codex and Gemini together: every review still came back, and still correct.

**A pipeline you can change while it runs.** Six internal agents (comprehension,
anti-hallucination, text review, jury, legal, learning) live in a versioned configuration.
Publish a new version and every open Claude Code chat picks it up on its **next
message**: no restart, no lost history. Roll back the same way.

## What we measured

On one developer machine (Windows 11, Codex CLI and Antigravity CLI on personal plans,
October 2026). Your numbers will differ; `gauntlet stats` shows yours.

| | |
|---|---|
| `quick_check` on a one-file question (Gemini, light tier) | 25 s; ~31k tokens on Google's side, none on Claude's for the review itself |
| The same question again, file unchanged | 0.0 s, served from cache |
| Two-family council on the same file | 108 s, found 2 real bugs that one family missed |
| 44,500-character document through the text-review agent | 32 s, caught the typo in the last sentence |
| Regression suite for the six internal agents | 5/5 on live models |
| Codex unavailable / Codex and Gemini both unavailable | answered by Gemini / by Claude, still 5/5 |

## Quick start

You need Node 20+, [Claude Code](https://docs.claude.com/en/docs/claude-code), and at
least one of:
- the **Codex CLI**, signed in with ChatGPT (`codex login`);
- the **Antigravity CLI** (`agy`), signed in with Google. This also gives you GPT-OSS
  and the Claude fallback lane.

```bash
git clone https://github.com/Raffymimii/gauntlet.git
cd gauntlet && npm install
node bin/gauntlet.mjs init --dry-run    # shows every change it would make
node bin/gauntlet.mjs init              # registers the MCP server and the subagents
node bin/gauntlet.mjs status            # are the CLIs installed and signed in?
```

Open a **new** Claude Code chat and ask for a review: *"get a codex_review of this diff"*.

Optional extras:

```bash
node bin/gauntlet.mjs init --claude-md            # teach Claude when to use which tool
node bin/gauntlet.mjs init --hooks turn           # live runtime + internal agents
node bin/gauntlet.mjs init --hooks review-gate    # no git push while edits are unreviewed
node bin/gauntlet.mjs uninstall                   # removes exactly what it added
```

## The tools

| Tool | Who answers | Use it for |
|---|---|---|
| `quick_check` | Gemini, light | a fast look at a function, regex, query or config |
| `codex_review` | Codex, auto tier | adversarial review of a diff or a few files |
| `gemini_review` | Gemini, auto tier | contracts, error paths, state, UX regressions |
| `codex_diagnose` | Codex | root cause of a bug, from symptom to line |
| `gemini_analyze` | Gemini | how unfamiliar code fits together |
| `plan_critique` | Codex | a plan, *before* any code is written |
| `security_audit` | Codex, deep tier | exploitable issues, with the attack spelled out |
| `edge_cases` | Gemini | inputs the code mishandles, written as test cases |
| `council` | Codex + Gemini + GPT-OSS | one question, three families, agreement and disagreement |
| `gauntlet_status` | none | what's installed, signed in, paused, and why |

There are also four read-only Claude subagents:
- `haiku-navigator` finds things;
- `sonnet-reviewer` reviews when every other provider is down;
- `opus-architect` plans large changes;
- `sonnet-test-analyst` runs your tests (opt-in).

## How it works

```
Claude Code ──tool call──► gauntlet MCP server
                              │ build a packet: objective, named files, diff, checks
                              │   (credentials refused, secrets redacted, never the chat)
                              │ pick a tier, walk the fallback chain, skip paused models
                              ▼
                 codex exec --sandbox read-only    agy --mode plan --sandbox
                              │
                              ▼ structured JSON answer
                 look up every quoted line in the real file
                 remember findings per project ("seen before, 12 days ago")
                 cache on the exact file contents
                              │
Claude Code ◄──── verified / not checkable / could not be confirmed
```

More detail: [architecture](docs/architecture.md), [security model](docs/security.md),
[configuration](docs/configuration.md).

## Safety

- **Read-only, by construction.** Codex runs in its read-only sandbox, Antigravity in plan
  mode, both with a hard timeout and a scrubbed environment. A specialist can't call
  another specialist.
- **What leaves your machine is what you name.** It never sends:
  - the conversation;
  - `.env` files, keys, or anything under `.ssh` or `.aws`;
  - symlinks leading outside the project;
  - binaries.

  `gauntlet packet` prints the exact packet without sending it.
- **The installer changes nothing you didn't ask for.** Hooks are opt-in, `settings.json`
  is backed up first, and `uninstall` removes only its own entries.

## FAQ

**Does it use API keys or bill me per token?**
No. It drives the official CLIs on your existing logins.

**Do I need both Codex and Antigravity?**
No. With one, Gauntlet uses that one. With neither, you still get the Claude subagents.

**Can a reviewer change my code?**
No. Specialists are read-only, and Claude decides what to apply.

**Is it allowed by my providers' terms?**
Gauntlet runs the official tools, under your own account, at your own pace. It backs off
when a provider says you're out of quota. Check your plans' terms for your use; that part
is between you and them.

**Why not just ask Claude to review its own work?**
You can, and sometimes you should. But a second family catches different things, and a
reviewer whose findings are checked against the file can't waste your afternoon with a
bug that isn't there.

## Contributing

Issues and pull requests are welcome. If you change a prompt, run the agent regression
suite (`node bin/gauntlet.mjs regress`) and include the result. If you have measured the
savings on real work, please share the numbers and the method.

## License

MIT
