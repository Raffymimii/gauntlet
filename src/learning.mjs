// Regression checks and the learning loop.
//
// "Learning" here means versioned configuration changes, never model training. The
// learning agent proposes; a person applies lessons and prompt changes; only regression
// cases are applied automatically, because adding a check cannot change behaviour. Even
// those must pass validateExpect, so a check that could never be evaluated is not added.
import { currentRuntime, saveProposal, applyProposal, setProposalStatus } from './runtime/store.mjs';
import { validateExpect, AGENT_IDS } from './runtime/validate.mjs';

const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Whether an agent's answer meets a regression case's expectation. */
export function checkExpectation(expect, result) {
  const v = expect.value;
  switch (expect.kind) {
    case 'min_severity': {
      const worst = Math.max(-1, ...(result.findings || []).map((f) => SEVERITIES.indexOf(f.severity)));
      return { pass: worst >= SEVERITIES.indexOf(v), detail: `most severe finding ${SEVERITIES[worst] ?? 'none'}, needed ${v}` };
    }
    case 'verdict_not': {
      const verdict = result.verdict ?? result.decision;
      return { pass: verdict !== v, detail: `verdict ${verdict}` };
    }
    case 'winner':
      return { pass: String(result.winner || '').toUpperCase() === v.toUpperCase(), detail: `winner ${result.winner ?? 'none'}, decision ${result.decision}` };
    case 'non_empty':
      return { pass: Array.isArray(result[v]) && result[v].length > 0, detail: `${v}: ${Array.isArray(result[v]) ? result[v].length : 'missing'}` };
    case 'is_true':
      return { pass: result[v] === true, detail: `${v} = ${result[v]}` };
    case 'contains':
      return { pass: JSON.stringify(result).toLowerCase().includes(v.toLowerCase()), detail: `looked for "${v}"` };
    case 'not_contains':
      return { pass: !JSON.stringify(result).toLowerCase().includes(v.toLowerCase()), detail: `must not contain "${v}"` };
    default:
      return { pass: false, detail: `unknown expectation ${expect.kind}` };
  }
}

/**
 * Stores the learning agent's proposals and auto-applies the safe ones that are valid.
 * @returns {Promise<Array<{id, kind, risk, status, note?}>>}
 */
export async function recordAnalysis(analysis, { eventId = null } = {}) {
  const cfg = currentRuntime().config;
  const out = [];
  for (const p of analysis.proposals || []) {
    const id = saveProposal({ ...p, eventId, classification: analysis.classification });
    const entry = { id, kind: p.kind, risk: p.risk, status: 'pending' };

    const canAutoApply = cfg.routing?.autoApply !== 'none' && p.risk === 'safe' && p.kind === 'regression_case';
    if (canAutoApply) {
      const agentOk = AGENT_IDS.includes(p.target_agent);
      const problem = !agentOk
        ? 'unknown target agent'
        : validateExpect(cfg.agents[p.target_agent], { kind: p.regression_expect_kind, value: p.regression_expect_value });
      if (problem) {
        setProposalStatus(id, 'rejected', { note: `not applied automatically: ${problem}` });
        Object.assign(entry, { status: 'rejected', note: problem });
      } else {
        const r = await applyProposal(id, { automatic: true });
        Object.assign(entry, r.ok ? { status: 'applied', version: r.version } : { note: r.errors.join('; ') });
      }
    }
    out.push(entry);
  }
  return out;
}
