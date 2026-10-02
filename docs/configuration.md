# Configuration

## ~/.gauntlet/config.json

Anything you put here overrides [config/default.json](../config/default.json). Only list
what you change:

```json
{
  "tiers": {
    "deep": { "codex": { "model": "gpt-6-astra", "effort": "xhigh" } }
  },
  "lanes": { "oss": { "enabled": false } },
  "fallback": { "crossFamily": false },
  "limits": { "maxConcurrent": 2 }
}
```

| Key | Meaning |
|---|---|
| `tiers.<tier>.<lane>.model` | model per tier and family. Update these when a provider renames a model. |
| `tiers.<tier>.codex.effort` | Codex reasoning effort for that tier |
| `tiers.<tier>.timeoutMs` | time budget per attempt |
| `lanes.<lane>.enabled` | turn a family off entirely |
| `lanes.claude.model` | the last-resort model served through Antigravity |
| `fallback.crossFamily` | let a call move to another provider when its own is unavailable |
| `providers.codex.command` / `providers.antigravity.command` | CLI path, if it isn't on PATH |
| `providers.*.home` | run the CLI with a different home directory (separate login) |
| `limits.*` | concurrency, packet size, files per call, bytes per file, output size |
| `cache.enabled`, `cache.ttlMs` | result cache |
| `events.enabled` | local metadata log used by `gauntlet stats` |

If the file isn't valid JSON, Gauntlet uses the defaults and `gauntlet status` says why.

`GAUNTLET_HOME` moves the whole data directory, which is handy for tests or for keeping
two setups apart.

## Runtime configuration

The internal agents, routing and policy are versioned separately. See the Runtime
section of the README. The shape:

```json
{
  "schemaVersion": 1,
  "policy": { "summary": "...", "rules": ["..."] },
  "routing": {
    "trivialMaxChars": 140,
    "comprehension": { "mode": "auto", "minChars": 700, "minRequirements": 4, "timeoutMs": 40000 },
    "legalKeywords": ["privacy", "..."],
    "feedbackPatterns": ["that's wrong", "..."],
    "autoApply": "safe"
  },
  "agents": {
    "jury": {
      "name": "Jury", "role": "...", "enabled": true,
      "lane": "codex", "tier": "standard", "fallback": ["gemini"], "timeoutMs": 300000,
      "output": "jury", "prompt": "...", "promptVersion": 1, "lessons": []
    }
  },
  "regressions": [
    { "id": "jury-wrong-fact", "agent": "jury", "input": "...", "expect": { "kind": "winner", "value": "B" } }
  ]
}
```

`routing.comprehension.timeoutMs` is capped at 45000 so the pre-turn hook always answers
inside Claude Code's hook timeout. The patterns in `feedbackPatterns` and `legalKeywords`
are plain substrings: add the phrases you actually use, in your own language.

### Regression expectations

| kind | value |
|---|---|
| `min_severity` | `INFO`, `LOW`, `MEDIUM`, `HIGH` or `CRITICAL` |
| `verdict_not` | a verdict the agent must not return |
| `winner` | a candidate letter (jury) |
| `non_empty` | a list field of the agent's answer, e.g. `ambiguities` |
| `is_true` | a true/false field of the agent's answer, e.g. `relevant` |
| `contains` / `not_contains` | a short keyword, at most six words |

A case that doesn't fit these rules is refused at publish time.
