# Token savings

The honest version: gauntlet doesn't make the total number of tokens in the world go down.
A second review costs tokens. What it changes is **where** they are spent and **how many
of them are spent on the expensive context**.

## Where the savings come from

**1. Small packets instead of the whole conversation.**
A Claude Code session easily carries 100k+ tokens of context: the conversation, file
reads, tool output. Asking Claude itself to "now review this carefully" re-reads that
context. A gauntlet specialist gets a packet with the objective, the files named, the diff
and the checks. That is usually a few thousand characters (`gauntlet stats` shows your
average), plus the provider CLI's own system prompt.

**2. The work runs on other plans.**
Reviews, diagnoses and edge-case hunting run on your ChatGPT plan (Codex) or your Google
plan (Antigravity). That is quota you already pay for and would otherwise leave unused.
Your Claude plan is kept for the work only Claude is doing: understanding your
request, editing, deciding.

**3. The cheapest model that can do the job.**
Every call runs at a tier. `quick_check` defaults to `light`. `auto` sends small,
ordinary questions to light models and keeps the flagship models for security, money,
concurrency and production. A three-word question never needs the biggest model.

**4. No agent on trivial turns.**
The `turn` hook routes cheaply without calling a model. Short messages get nothing. The
comprehension pass runs only on long or multi-part requests.

**5. A cache keyed on your actual code.**
A repeated question about unchanged files is answered from the cache in milliseconds.
The cache key includes a hash of every file in the packet, so changing a file
invalidates it.

**6. Fewer wasted turns (harder to measure).**
A finding that points at code that doesn't exist is marked as such before Claude reads
it, so Claude doesn't spend turns chasing it. A bug caught in review costs less than the
same bug found by three rounds of debugging. This is plausible, not measured: treat it as
a hypothesis.

## What it costs

- Specialist calls take time: seconds for `light`, a minute or more for `deep` or a
  council.
- Provider CLIs carry their own system prompts. In our runs, a packet of 4 to 6 thousand
  characters showed up as roughly 13k to 17k input tokens on Codex (much of it
  provider-cached) and about 30k on Gemini. That is why trivia shouldn't go to a
  specialist.
- The comprehension pass adds 10 to 40 seconds before Claude starts on long requests.

## Measuring it yourself

`gauntlet stats` reads the local event log (`~/.gauntlet/events`) and reports:
- calls, answers, failures and fallbacks;
- cache hits, which are calls where no model ran at all;
- input and output tokens per provider and model, when the CLI reports them;
- average packet size;
- how many findings were verified against your files.

To compare against a baseline:

1. Pick a fixed set of tasks from your own work (say 10 changes: a few small, a few
   risky).
2. Do them once with gauntlet installed and once without, in fresh chats, with the same
   instructions.
3. For each run, record what Claude Code reports for the session (`/cost` or your plan's
   usage page), and `gauntlet stats --days 1` for the gauntlet side.
4. Compare Claude usage per task, total wall time, and defects found later.

Publish your numbers with the method if you share them. We would rather show a measured
10% than claim an unmeasured 80%.
