// The status report shared by the MCP tool and `gauntlet status`.
import { config, HOME } from './config.mjs';
import { providerStatus } from './providers.mjs';
import { TIERS, pausedModels } from './router.mjs';
import { cacheSize } from './cache.mjs';
import { limiterState, NESTED } from './consult.mjs';

function cliLine(name, s, signInHint) {
  if (!s.installed) return `**${name}**: not found (\`${s.command}\`). ${name === 'Codex CLI' ? 'Install it and run `codex login`.' : 'Install the Antigravity CLI and run `agy` once to sign in.'}`;
  return `**${name}**: ${s.version}, ${s.signedIn ? `signed in${s.method ? ` (${s.method})` : ''}` : `NOT signed in: ${signInHint}`}`;
}

export async function statusReport() {
  const st = await providerStatus();
  const lanes = Object.entries(config.lanes).map(([l, v]) => `${l} ${v.enabled === false ? 'off' : 'on'}`).join(', ');
  const paused = pausedModels();
  const lim = config.limits;
  const { running, queued } = limiterState();
  return [
    '# Providers',
    cliLine('Codex CLI', st.codex, 'run `codex login`'),
    cliLine('Antigravity CLI', st.antigravity, 'run `agy` once and sign in'),
    '',
    '# Tiers',
    ...TIERS.map((t) => {
      const x = config.tiers[t] || {};
      return `- **${t}**: codex ${x.codex?.model ?? '-'}${x.codex?.effort ? ` (${x.codex.effort})` : ''}, gemini ${x.gemini?.model ?? '-'}, oss ${x.oss?.model ?? '-'}, timeout ${Math.round((x.timeoutMs || 0) / 1000)}s`;
    }),
    `- last resort: claude ${config.lanes.claude?.model ?? '-'} through Antigravity`,
    `- lanes: ${lanes}; cross-family fallback ${config.fallback?.crossFamily === false ? 'off' : 'on'}`,
    '',
    '# Paused after failures',
    ...(paused.length ? paused.map((p) => `- ${p.key}: ${p.kind}, ${p.minutesLeft} min left`) : ['- none']),
    '',
    '# Limits',
    `- ${lim.maxConcurrent} calls at once (${running} running, ${queued} queued)`,
    `- packet up to ${lim.maxPacketChars} chars, ${lim.maxPathsPerCall} paths, ${lim.maxFileBytes} bytes per file`,
    `- cache ${config.cache.enabled ? `on, ${cacheSize()} entries, ${config.cache.ttlMs / 60000} min` : 'off'}`,
    `- data directory: ${HOME}`,
    ...(NESTED ? ['- running inside a specialist: calls are refused'] : []),
    ...(config._error ? [`- CONFIG ERROR, using defaults: ${config._error}`] : []),
  ].join('\n');
}
