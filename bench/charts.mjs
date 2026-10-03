#!/usr/bin/env node
// Draws the README charts from bench/results/summary.json, as static SVG in a light and a
// dark version (the README picks one with <picture> and prefers-color-scheme).
//
// One measure per chart, horizontal bars, every bar labelled with its name and value.
// Gauntlet rows are blue, single models are gray: the color only adds emphasis, the text
// carries the meaning.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'docs', 'bench');
const summary = JSON.parse(fs.readFileSync(path.join(HERE, 'results', 'summary.json'), 'utf8'));

const THEMES = {
  light: { surface: '#fcfcfb', text: '#0b0b0b', secondary: '#52514e', muted: '#8b8a85', grid: '#e7e6e2', emphasis: '#2a78d6' },
  dark: { surface: '#1a1a19', text: '#ffffff', secondary: '#c3c2b7', muted: '#76756f', grid: '#2e2e2c', emphasis: '#3987e5' },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A bar with a 4px rounded end on the data side, square at the baseline. */
function bar(x, y, w, h, fill) {
  if (w <= 0) return '';
  const r = Math.min(4, w, h / 2);
  return `<path d="M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z" fill="${fill}"/>`;
}

function chart({ title, subtitle, rows, max, ticks, theme }) {
  const t = THEMES[theme];
  const W = 760;
  const labelW = 270;
  const valueW = 110;
  const plotW = W - labelW - valueW - 24;
  const top = 74;
  const rowH = 36;
  const barH = 18;
  const H = top + rows.length * rowH + 30;
  const x0 = labelW;
  const sx = (v) => (v / max) * plotW;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`,
    `<rect width="${W}" height="${H}" rx="8" fill="${t.surface}"/>`,
    `<text x="20" y="30" font-size="16" font-weight="600" fill="${t.text}">${esc(title)}</text>`,
    `<text x="20" y="52" font-size="12.5" fill="${t.secondary}">${esc(subtitle)}</text>`,
  ];
  for (const tick of ticks) {
    const x = x0 + sx(tick);
    parts.push(`<line x1="${x}" y1="${top - 6}" x2="${x}" y2="${top + rows.length * rowH - 6}" stroke="${t.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${x}" y="${top + rows.length * rowH + 10}" font-size="11" text-anchor="middle" fill="${t.secondary}">${tick}</text>`);
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const fill = r.emphasis ? t.emphasis : t.muted;
    parts.push(`<text x="${labelW - 12}" y="${y + barH / 2 + 4}" font-size="13" text-anchor="end" fill="${t.text}" font-weight="${r.emphasis ? 600 : 400}">${esc(r.label)}</text>`);
    parts.push(bar(x0, y, sx(r.value), barH, fill));
    parts.push(`<text x="${x0 + sx(r.value) + 8}" y="${y + barH / 2 + 4}" font-size="12.5" fill="${t.text}">${esc(r.display)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('\n');
}

const rows = summary.rows;
const isGauntlet = (r) => r.label.includes('Gauntlet');
const span = (xs) => (Math.min(...xs) === Math.max(...xs) ? '' : ` (runs: ${xs.join(', ')})`);
const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

const charts = {
  'bugs-found': {
    title: `Seeded bugs found, out of ${summary.buggy}`,
    subtitle: `Same prompt, same files, ${summary.runs} run(s). A bug counts only if the finding names it at the right line.`,
    rows: rows.map((r) => ({ label: r.label, value: r.foundMean, display: `${fmt(r.foundMean)}${span(r.found)}`, emphasis: isGauntlet(r) })),
    max: summary.buggy,
    ticks: [0, 3, 6, 9, 12].filter((x) => x <= summary.buggy),
  },
  'false-alarms': {
    title: `False alarms on ${summary.clean} bug-free files`,
    subtitle: 'High or medium findings on code with nothing wrong in it, per run. Lower is better.',
    rows: rows.map((r) => ({ label: r.label, value: r.falseAlarmsMean, display: fmt(r.falseAlarmsMean), emphasis: isGauntlet(r) })),
    max: Math.max(1, ...rows.map((r) => r.falseAlarmsMean)) * 1.15,
    ticks: [],
  },
  'made-up': {
    title: 'Findings that quote code that is not in the file',
    subtitle: 'Share of each model\'s findings. Gauntlet looks every quote up and labels these before Claude reads them.',
    rows: rows.filter((r) => !isGauntlet(r)).map((r) => {
      const pct = r.findings ? (100 * r.madeUp) / r.findings : 0;
      return { label: r.label, value: pct, display: `${pct.toFixed(0)}%  (${r.madeUp} of ${r.findings})`, emphasis: false };
    }),
    max: Math.max(10, ...rows.filter((r) => !isGauntlet(r)).map((r) => (r.findings ? (100 * r.madeUp) / r.findings : 0))) * 1.2,
    ticks: [],
  },
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, spec] of Object.entries(charts)) {
  for (const theme of Object.keys(THEMES)) {
    fs.writeFileSync(path.join(OUT, `${name}-${theme}.svg`), chart({ ...spec, theme }));
  }
}
console.log(`wrote ${Object.keys(charts).length * 2} SVG files to ${path.relative(process.cwd(), OUT)}`);
