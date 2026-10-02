// What makes a runtime configuration valid. Checked on publish and again on load, so a
// hand-edited version file that doesn't pass is never used.
import { TIERS } from '../router.mjs';
import { AGENT_SCHEMAS } from '../schemas.mjs';

export const AGENT_IDS = ['comprehension', 'anti_hallucination', 'text_review', 'jury', 'legal', 'learning'];
export const EXPECT_KINDS = ['min_severity', 'verdict_not', 'winner', 'non_empty', 'is_true', 'contains', 'not_contains'];
const AGENT_LANES = ['codex', 'gemini', 'oss'];
const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

// The pre-turn hook must answer inside Claude Code's hook timeout (60 s as installed).
export const MAX_COMPREHENSION_MS = 45000;
const MAX_REGRESSIONS = 100;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;

/**
 * A regression check has to be one the runner can actually evaluate against that
 * agent's answer. Learned cases used to arrive as full sentences in a `contains` or as a
 * field name that doesn't exist; those can never pass and only add noise.
 */
export function validateExpect(agentConfig, expect) {
  if (!isObj(expect) || !EXPECT_KINDS.includes(expect.kind)) return `expect.kind must be one of ${EXPECT_KINDS.join(', ')}`;
  const v = expect.value;
  if (typeof v !== 'string' || !v.trim()) return 'expect.value must be a non-empty string';
  const schema = AGENT_SCHEMAS[agentConfig?.output];
  const props = schema?.properties || {};
  switch (expect.kind) {
    case 'min_severity':
      return SEVERITIES.includes(v) ? null : `expect.value must be one of ${SEVERITIES.join(', ')}`;
    case 'non_empty':
      return props[v]?.type === 'array' ? null : `"${v}" is not a list field of the ${agentConfig?.output} answer`;
    case 'is_true':
      return props[v]?.type === 'boolean' ? null : `"${v}" is not a true/false field of the ${agentConfig?.output} answer`;
    case 'verdict_not': {
      const allowed = props.verdict?.enum || props.decision?.enum;
      return allowed?.includes(v) ? null : `"${v}" is not a possible verdict of this agent`;
    }
    case 'winner':
      return /^[A-Z]$/.test(v) ? null : 'expect.value must be a candidate label such as A or B';
    case 'contains':
    case 'not_contains':
      return v.length <= 60 && v.split(/\s+/).length <= 6 ? null : 'expect.value must be a short keyword (at most six words): a whole sentence is never reproduced verbatim';
    default:
      return null;
  }
}

export function validateRuntime(cfg) {
  const errors = [];
  if (!isObj(cfg)) return { ok: false, errors: ['config is not an object'] };
  if (cfg.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!isObj(cfg.policy) || typeof cfg.policy.summary !== 'string' || !Array.isArray(cfg.policy.rules) || cfg.policy.rules.some((r) => typeof r !== 'string')) {
    errors.push('policy needs a summary and a list of rules');
  }

  const R = cfg.routing;
  if (!isObj(R)) errors.push('routing is missing');
  else {
    if (R.trivialMaxChars !== undefined && !isCount(R.trivialMaxChars)) errors.push('routing.trivialMaxChars must be a non-negative integer');
    const C = R.comprehension;
    if (C !== undefined) {
      if (!isObj(C)) errors.push('routing.comprehension must be an object');
      else {
        if (C.mode !== undefined && !['auto', 'always', 'off'].includes(C.mode)) errors.push('routing.comprehension.mode must be auto, always or off');
        for (const k of ['minChars', 'minRequirements', 'timeoutMs']) if (C[k] !== undefined && !isCount(C[k])) errors.push(`routing.comprehension.${k} must be a non-negative integer`);
        if (C.timeoutMs > MAX_COMPREHENSION_MS) errors.push(`routing.comprehension.timeoutMs must be at most ${MAX_COMPREHENSION_MS}`);
      }
    }
    for (const k of ['legalKeywords', 'feedbackPatterns']) {
      if (R[k] !== undefined && (!Array.isArray(R[k]) || R[k].some((x) => typeof x !== 'string'))) errors.push(`routing.${k} must be a list of strings`);
    }
    if (R.autoApply !== undefined && !['safe', 'none'].includes(R.autoApply)) errors.push('routing.autoApply must be safe or none');
  }

  if (!isObj(cfg.agents)) errors.push('agents is missing');
  else {
    for (const [id, a] of Object.entries(cfg.agents)) {
      const at = `agents.${id}`;
      if (!AGENT_IDS.includes(id)) { errors.push(`${at}: unknown agent`); continue; }
      if (!isObj(a)) { errors.push(`${at}: not an object`); continue; }
      if (typeof a.enabled !== 'boolean') errors.push(`${at}.enabled must be true or false`);
      if (!AGENT_LANES.includes(a.lane)) errors.push(`${at}.lane must be codex, gemini or oss`);
      if (!TIERS.includes(a.tier)) errors.push(`${at}.tier must be light, standard or deep`);
      if (!Array.isArray(a.fallback) || a.fallback.some((l) => !AGENT_LANES.includes(l) || l === a.lane)) errors.push(`${at}.fallback must list other lanes`);
      if (!AGENT_SCHEMAS[a.output]) errors.push(`${at}.output must be one of ${Object.keys(AGENT_SCHEMAS).join(', ')}`);
      if (typeof a.prompt !== 'string' || a.prompt.trim().length < 40) errors.push(`${at}.prompt is missing or too short`);
      if (!Number.isInteger(a.promptVersion) || a.promptVersion < 1) errors.push(`${at}.promptVersion must be a positive integer`);
      if (!Number.isInteger(a.timeoutMs) || a.timeoutMs < 10000 || a.timeoutMs > 900000) errors.push(`${at}.timeoutMs must be between 10000 and 900000`);
      if (!Array.isArray(a.lessons) || a.lessons.some((l) => typeof l !== 'string')) errors.push(`${at}.lessons must be a list of strings`);
    }
    for (const id of AGENT_IDS) if (!cfg.agents[id]) errors.push(`agents.${id} is missing`);
  }

  if (!Array.isArray(cfg.regressions)) errors.push('regressions must be a list');
  else {
    if (cfg.regressions.length > MAX_REGRESSIONS) errors.push(`at most ${MAX_REGRESSIONS} regression cases: prune old learned ones first`);
    const seen = new Set();
    for (const r of cfg.regressions) {
      const at = `regression ${r?.id ?? '?'}`;
      if (typeof r?.id !== 'string' || seen.has(r.id)) errors.push(`${at}: missing or duplicate id`);
      seen.add(r?.id);
      if (!AGENT_IDS.includes(r?.agent)) { errors.push(`${at}: unknown agent`); continue; }
      if (typeof r.input !== 'string' || !r.input.trim()) errors.push(`${at}: empty input`);
      const bad = validateExpect(cfg.agents?.[r.agent], r.expect);
      if (bad) errors.push(`${at}: ${bad}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
