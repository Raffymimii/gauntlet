// `tandem stats` and `tandem runtime diff`.

function sum(rows, key) {
  return rows.reduce((n, r) => n + (Number.isFinite(r[key]) ? r[key] : 0), 0);
}

function pct(a, b) {
  return b ? `${Math.round((a / b) * 100)}%` : '-';
}

function fmt(n) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function renderStats(events) {
  if (!events.length) return 'No calls recorded yet. Events are logged in ~/.tandem/events once tandem is in use.';
  const live = events.filter((e) => !e.cached);
  const cached = events.filter((e) => e.cached);
  const ok = events.filter((e) => e.status === 'ok');
  const withUsage = live.filter((e) => Number.isFinite(e.inputTokens));
  const out = [];

  out.push(`# Last ${Math.ceil((Date.now() - Math.min(...events.map((e) => e.ts))) / 86_400_000)} day(s)`);
  out.push(`- calls: ${events.length} (${ok.length} answered, ${events.length - ok.length} failed)`);
  out.push(`- served from cache: ${cached.length} (${pct(cached.length, events.length)}), no model run at all`);
  out.push(`- answered after a fallback: ${live.filter((e) => e.status === 'ok' && e.fallbacks > 0).length}`);
  const checked = sum(events, 'checked');
  if (checked) out.push(`- findings checked against files: ${checked}, verified ${pct(sum(events, 'verified'), checked)}`);

  out.push('', '# Work done on other subscriptions');
  out.push('Every token below ran on Codex or Antigravity instead of your Claude plan.');
  out.push(`- reported usage on ${withUsage.length} of ${live.length} model runs (not every CLI reports it every time)`);
  out.push(`- input: ${fmt(sum(withUsage, 'inputTokens'))} tokens (${fmt(sum(withUsage, 'cachedInputTokens'))} of them provider-cached)`);
  out.push(`- output: ${fmt(sum(withUsage, 'outputTokens'))} tokens`);
  const packets = live.filter((e) => Number.isFinite(e.packetChars));
  if (packets.length) out.push(`- average packet: ${fmt(Math.round(sum(packets, 'packetChars') / packets.length))} characters`);

  out.push('', '# By model');
  const byModel = new Map();
  for (const e of live) {
    const k = `${e.lane ?? '?'} / ${e.model ?? '?'}`;
    const m = byModel.get(k) ?? { calls: 0, ok: 0, ms: 0, inT: 0, outT: 0 };
    m.calls++;
    if (e.status === 'ok') { m.ok++; m.ms += e.durationMs || 0; }
    m.inT += e.inputTokens || 0;
    m.outT += e.outputTokens || 0;
    byModel.set(k, m);
  }
  for (const [k, m] of [...byModel].sort((a, b) => b[1].calls - a[1].calls)) {
    out.push(`- ${k}: ${m.calls} calls, ${pct(m.ok, m.calls)} answered, avg ${m.ok ? (m.ms / m.ok / 1000).toFixed(1) : '-'}s, ${fmt(m.inT)} in / ${fmt(m.outT)} out`);
  }

  out.push('', '# By tool or agent');
  const byTool = new Map();
  for (const e of events) {
    const k = e.tool || `agent:${e.agent}`;
    byTool.set(k, (byTool.get(k) || 0) + 1);
  }
  for (const [k, n] of [...byTool].sort((a, b) => b[1] - a[1])) out.push(`- ${k}: ${n}`);

  const errors = events.filter((e) => e.status === 'error');
  if (errors.length) {
    out.push('', '# Failures');
    const byErr = new Map();
    for (const e of errors) byErr.set(e.error, (byErr.get(e.error) || 0) + 1);
    for (const [k, n] of byErr) out.push(`- ${k}: ${n}`);
  }
  return out.join('\n');
}

/** Flat list of changed paths between two configurations. */
export function diffConfigs(a, b, prefix = '') {
  const changes = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const p = prefix ? `${prefix}.${k}` : k;
    const x = a?.[k];
    const y = b?.[k];
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      changes.push(...diffConfigs(x, y, p));
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      const show = (v) => (v === undefined ? '(none)' : JSON.stringify(v).slice(0, 160));
      changes.push(`${p}: ${show(x)} -> ${show(y)}`);
    }
  }
  return changes;
}
