# How it works

## One call

```
Claude ── tool call ──► server.mjs
                           │
                           ▼
                      consult.mjs
   packet.mjs   build the packet: role, objective, files (redacted), diff, checks, format
   router.mjs   pick the tier, build the fallback chain, skip paused models
   providers    run `codex exec` or `agy --print` read-only, with a JSON schema
   verify.mjs   look for each finding's quoted line in the real file
   findings.mjs remember the finding for this project ("seen before")
   report.mjs   render: verified / not checkable / could not be confirmed
   cache.mjs    store the result, keyed on the exact file contents
   events.mjs   log metadata (model, time, tokens) for `gauntlet stats`
```

## The fallback chain

For a call on lane `codex` at tier `deep`:

```
codex/deep -> codex/standard -> gemini/deep -> oss/deep -> claude (via Antigravity)
```

- **Moves to the next model:** quota exhausted, model unavailable, not signed in, CLI
  missing, empty answer, provider error.
- **Stops:** a timeout. Trying elsewhere would double the wait. (The internal agents handle
  timeouts differently; see below.)

A model that failed is paused (20 minutes for quota, longer for "model not available").
The pause is recorded in `~/.gauntlet/state/provider-health.json`, so every process sees it.

A council turns cross-family fallback off, so its voices stay distinct families.

## Internal agents

The six agents in `prompts/agents/` are run by `gauntlet agent <id>`, and the
comprehension agent also by the `turn` hook. Each one is defined in the runtime
configuration by:
- a lane;
- a tier;
- fallback lanes;
- a time budget;
- a prompt, with lessons appended;
- an answer schema.

Their models are tried **side by side, not one after the other**. The first one starts with
the whole budget; if it is still thinking after 40% of that budget, the next family starts
beside it; the first valid answer wins and the losers are cancelled through an
`AbortSignal`, so no CLI is left burning quota on an answer nobody will read.

That matters more than it sounds. The obvious design is a queue that splits the budget
between the models, and it fails in a way that is easy to miss: with a 45-second budget, a
first model that needs 26 seconds on a bad day is killed at 27, the second is handed 11
seconds, which is not enough to answer at all, and the agent returns nothing even though
both models were working. Measured over 338 real calls, that design answered 64% of the
time and every single failure was a timeout. Hedging removes the whole class.

An agent also moves on after a timeout or a malformed answer, unlike the MCP tools, because
Claude is waiting for the result. After an empty or malformed answer the same model is asked
once more with a reminder, which is quicker than waiting for another family to start. If
every model is paused, the last resort is tried anyway.

## Runtime versions and open chats

Claude Code reads CLAUDE.md and starts MCP servers when a chat opens. The `turn` hook
runs as a new process on every message, so it is the one place that can change behaviour
in a chat that is already open:

1. It reads the highest valid version in `~/.gauntlet/runtime/versions/`.
2. It compares it with the version that chat last saw (kept per session in
   `runtime/sessions/`).
3. When the version is newer, it injects the policy and agent list as additional
   context. The conversation history is left alone; the new rules apply from that
   message on.

Versions only go up. A rollback is a new version that copies an older one, and a
hand-edited version file that fails validation is skipped.

## Files

| Path | What |
|---|---|
| `~/.gauntlet/config.json` | your overrides |
| `~/.gauntlet/cache/` | cached answers (1 hour) |
| `~/.gauntlet/state/` | model pauses, review-gate state |
| `~/.gauntlet/events/` | metadata log, one file per month |
| `~/.gauntlet/findings/` | per-project memory of findings |
| `~/.gauntlet/runtime/` | versions, sessions, traces, learning events, proposals |
