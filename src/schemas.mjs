// Answer shapes. Both CLIs accept a JSON schema, so findings come back as data that can
// be checked against the files, merged across providers and remembered.
//
// Every property is listed in `required` and optional ones are nullable instead: OpenAI's
// structured output rejects a schema whose `required` does not name every key. Gemini, for
// its part, rejects an enum that contains null, so nullable fields never use enums.

const str = (description) => ({ type: 'string', description });
const nstr = (description) => ({ type: ['string', 'null'], description });
const strs = (description, maxItems) => ({ type: 'array', items: { type: 'string' }, description, ...(maxItems ? { maxItems } : {}) });
const LEVEL = { type: 'string', enum: ['high', 'medium', 'low'] };
const SEVERITY = { type: 'string', enum: ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] };

function obj(properties) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

// ------------------------------------------------------------- specialist tools

export const REVIEW_SCHEMA = obj({
  verdict: { type: 'string', enum: ['approve', 'approve_with_changes', 'block'], description: 'block only if something would break or is unsafe.' },
  confidence: LEVEL,
  summary: str('One sentence a person can act on.'),
  findings: {
    type: 'array',
    maxItems: 12,
    items: obj({
      severity: LEVEL,
      file: str('Path relative to the project, exactly as given.'),
      line: { type: ['integer', 'null'], description: 'The line the finding is about; null if it is about the whole file.' },
      claim: str('What is wrong, in one sentence.'),
      evidence: nstr('The exact source text at that line, copied verbatim. It is checked against the file.'),
      fix: nstr('What to do: prose or at most five lines of code.'),
    }),
  },
  missed_edge_cases: strs('Cases the code does not handle.', 8),
  unanswered: strs('What you could not check, and why.', 8),
});

export const ANALYSIS_SCHEMA = obj({
  answer: str('The direct answer to the objective.'),
  confidence: LEVEL,
  structure: {
    type: 'array',
    maxItems: 10,
    items: obj({
      part: str('A file, module or component.'),
      role: str('What it does and what depends on it.'),
      file: nstr('Path relative to the project, or null.'),
    }),
  },
  risks: {
    type: 'array',
    maxItems: 10,
    items: obj({
      severity: LEVEL,
      claim: str('What looks wrong or fragile.'),
      file: nstr('Path relative to the project, or null.'),
      line: { type: ['integer', 'null'] },
      evidence: nstr('Verbatim source text, checked against the file.'),
    }),
  },
  unanswered: strs('What this material does not settle.', 8),
});

/** One list of checkable claims, whichever shape the answer has. */
export function claimsOf(answer) {
  if (!answer || typeof answer !== 'object') return [];
  if (Array.isArray(answer.findings)) return answer.findings;
  if (Array.isArray(answer.risks)) return answer.risks;
  return [];
}

// ------------------------------------------------------------- internal agents

const COMPREHENSION = obj({
  interpreted_intent: str('What the user wants, in one or two sentences, in their language.'),
  primary_goal: str('The single main outcome expected.'),
  secondary_goals: strs('Further outcomes asked for.'),
  constraints: strs('Hard limits the user set.'),
  preferences: strs('Soft wishes: style, tone, tools, order.'),
  required_output: strs('What must be delivered, and in which format.'),
  referenced_resources: strs('Files, paths, URLs, earlier messages the user points at.'),
  stated: strs('What the user said literally.'),
  inferred: strs('What can reasonably be deduced, and from what.'),
  ambiguities: strs('Points that can be read more than one way.'),
  missing_information: strs('Information needed and not available.'),
  unsafe_assumptions: strs('Assumptions that would be risky to act on.'),
  must_not_do: strs('Things the user clearly does not want done.'),
  recommended_execution_plan: strs('Ordered steps for the orchestrator.'),
  rewritten_prompt: str('The request rewritten for the orchestrator: complete, organised, same meaning and language, nothing added.'),
});

const HALLUCINATION = obj({
  verdict: { type: 'string', enum: ['clean', 'issues', 'unsafe'], description: 'unsafe: something fabricated the user would act on.' },
  summary: str('One sentence.'),
  findings: {
    type: 'array',
    items: obj({
      severity: SEVERITY,
      claim: str('The contested claim.'),
      kind: { type: 'string', enum: ['fact', 'source', 'url', 'api', 'file', 'function', 'package', 'config', 'number', 'date', 'quote', 'conclusion', 'assumption', 'overconfidence'] },
      status: { type: 'string', enum: ['verified', 'inference', 'estimate', 'opinion', 'hypothesis', 'unverifiable', 'contradicted', 'fabricated'] },
      reason: str('Why it is contested.'),
      recommended_fix: str('Verify, correct, hedge or remove: concretely.'),
      file: nstr('Project-relative file, when the claim is about code.'),
      line: { type: ['integer', 'null'] },
      evidence: nstr('Exact text at that line, so it can be checked.'),
    }),
  },
});

const TEXT_REVIEW = obj({
  verdict: { type: 'string', enum: ['pass', 'minor_fixes', 'needs_rewrite'] },
  summary: str('One sentence.'),
  issues: {
    type: 'array',
    items: obj({
      severity: SEVERITY,
      category: { type: 'string', enum: ['grammar', 'spelling', 'clarity', 'tone', 'structure', 'repetition', 'contradiction', 'verbosity', 'missing_information', 'instructions', 'format', 'unnatural', 'terminology', 'markdown', 'code', 'links'] },
      excerpt: str('The passage concerned.'),
      problem: str('What is wrong.'),
      suggestion: str('The fix.'),
    }),
  },
  corrected_text: nstr('The full corrected text when changes are needed; null when it passes.'),
  meaning_preserved: { type: 'boolean', description: 'True if the corrections keep meaning, data and code unchanged.' },
});

const SCORE = { type: 'integer', minimum: 1, maximum: 5 };
const JURY = obj({
  decision: { type: 'string', enum: ['pass', 'merge', 'revise', 'fail'] },
  winner: nstr('Label of the best candidate (A, B, ...), or null when none is good enough.'),
  rationale: str('Why, citing concrete points.'),
  ranking: {
    type: 'array',
    items: obj({
      candidate: str('Label.'),
      rank: { type: 'integer', minimum: 1 },
      scores: obj({
        correctness: SCORE, adherence: SCORE, completeness: SCORE, verifiability: SCORE,
        safety: SCORE, quality: SCORE, constraints: SCORE,
      }),
      strengths: strs('What is best in it.'),
      problems: strs('What is wrong with it.'),
    }),
  },
  merge_proposal: nstr('How to combine candidates, when decision is merge.'),
  revision_request: nstr('What must change, when decision is revise or fail.'),
});

const LEGAL = obj({
  relevant: { type: 'boolean', description: 'Whether there is any legal or documentation impact.' },
  summary: str('One or two sentences.'),
  findings: {
    type: 'array',
    items: obj({
      area: { type: 'string', enum: ['terms', 'privacy', 'cookies', 'gdpr', 'consent', 'retention', 'deletion', 'subprocessors', 'ai_disclosure', 'telemetry', 'accounts', 'payments', 'licences', 'intellectual_property', 'liability', 'other'] },
      issue: str('What the impact is.'),
      status: { type: 'string', enum: ['implemented', 'documented', 'to_verify', 'potentially_required', 'needs_counsel'] },
      severity: SEVERITY,
      recommended_action: str('Concrete next step.'),
    }),
  },
  tasks: strs('Concrete tasks to open.'),
});

const LEARNING = obj({
  classification: { type: 'string', enum: ['hallucination', 'misunderstanding', 'wrong_routing', 'tool_failure', 'incorrect_code', 'missing_requirement', 'style', 'false_alarm', 'other'] },
  summary: str('One sentence.'),
  failure_point: str('Where it went wrong: comprehension, routing, a named agent, the final answer, a tool.'),
  root_cause: str('The most likely cause.'),
  proposals: {
    type: 'array',
    items: obj({
      risk: { type: 'string', enum: ['safe', 'review', 'manual'] },
      kind: { type: 'string', enum: ['lesson', 'regression_case', 'prompt_change', 'routing_change', 'other'] },
      target_agent: nstr('Agent id the change applies to, or null for the orchestrator policy.'),
      change: str('The change, precisely.'),
      lesson: nstr('For kind=lesson: one imperative sentence.'),
      regression_input: nstr('For kind=regression_case: an input that reproduces the error.'),
      regression_expect_kind: nstr('For kind=regression_case, one of: min_severity, verdict_not, winner, non_empty, is_true, contains, not_contains.'),
      regression_expect_value: nstr('For kind=regression_case: the value the check uses. For non_empty and is_true, the name of a field of the target agent\'s answer. For contains, a short keyword, not a sentence.'),
    }),
  },
});

export const AGENT_SCHEMAS = {
  comprehension: COMPREHENSION,
  hallucination: HALLUCINATION,
  text_review: TEXT_REVIEW,
  jury: JURY,
  legal: LEGAL,
  learning: LEARNING,
};
