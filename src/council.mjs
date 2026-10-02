// Lines up a council's answers: each verdict, the findings two or more families reached
// independently (the strongest signal there is), and where they disagree. The judgement
// stays with Claude.
import { claimsOf } from './schemas.mjs';

const NEAR = 3;
const ORDER = { high: 0, medium: 1, low: 2 };
const norm = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/** Groups claims that point at the same file within a few lines of each other. */
export function clusterClaims(voices) {
  const clusters = [];
  for (const v of voices) {
    for (const c of v.claims) {
      if (!c.file) continue;
      const f = norm(c.file);
      let hit = null;
      let best = Infinity;
      for (const k of clusters) {
        if (k.file !== f) continue;
        if (c.line == null || k.line == null) {
          if (c.line == null && k.line == null) { hit = k; best = 0; }
          continue;
        }
        const d = Math.min(...k.items.filter((i) => i.line != null).map((i) => Math.abs(i.line - c.line)));
        if (d <= NEAR && d < best) { hit = k; best = d; }
      }
      if (hit) {
        hit.items.push({ lane: v.lane, ...c });
        hit.lanes.add(v.lane);
      } else {
        clusters.push({ file: f, line: c.line ?? null, label: c.file, items: [{ lane: v.lane, ...c }], lanes: new Set([v.lane]) });
      }
    }
  }
  return clusters;
}

const worst = (items) => items.map((i) => i.severity).sort((a, b) => (ORDER[a] ?? 3) - (ORDER[b] ?? 3))[0] || 'low';

export function mergeCouncil(results, { header, mode }) {
  const ok = results.filter((r) => r.ok);
  const lines = [`# Council (${mode}): ${ok.length}/${results.length} voices answered`];

  const verdicts = ok.map((r) => ({ lane: r.lane, model: r.model, verdict: r.json?.verdict || null, confidence: r.json?.confidence || '?' }));
  if (verdicts.length) {
    lines.push('', '## Verdicts');
    for (const v of verdicts) lines.push(`- **${v.lane}** (${v.model}): ${v.verdict ?? 'answered in prose'}, confidence ${v.confidence}`);
    const given = verdicts.filter((v) => v.verdict);
    const distinct = [...new Set(given.map((v) => v.verdict))];
    lines.push('', given.length < 2
      ? `**No consensus possible:** only ${given.length} structured verdict(s).`
      : distinct.length === 1
        ? `**Consensus (${given.length} voices):** ${distinct[0]}`
        : `**Disagreement:** ${distinct.join(' vs ')}. Resolve it with evidence, not by averaging.`);
  }

  const clusters = clusterClaims(ok.map((r) => ({ lane: r.lane, claims: r.json ? claimsOf(r.json) : [] })));
  const agreed = clusters.filter((k) => k.lanes.size >= 2).sort((a, b) => (ORDER[worst(a.items)] ?? 3) - (ORDER[worst(b.items)] ?? 3));
  lines.push('', `## Raised by two or more families (${agreed.length})`);
  if (!agreed.length) lines.push('- none');
  for (const k of agreed) {
    lines.push(`- [${worst(k.items)}] \`${k.label}${k.line != null ? `:${k.line}` : ''}\`: ${[...k.lanes].join(' + ')}`);
    for (const i of k.items) lines.push(`    - ${i.lane}: ${i.claim}`);
  }
  lines.push('', `Single-voice findings: ${clusters.length - agreed.length}. Treat them as leads to verify.`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    lines.push('', '## Voices that did not answer');
    for (const f of failed) lines.push(`- ${f.lane}: ${String(f.message).split('\n')[0]}`);
  }
  for (const r of ok) lines.push('', '---', `## ${r.lane}`, header(r), '', r.body);
  return lines.join('\n');
}
