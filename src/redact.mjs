// Keeps credentials out of everything that leaves the machine or lands in a log.

const SECRET_NAME = '[A-Za-z0-9_.-]*?(?:pass(?:word|wd)?|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|session[_-]?key|credential)s?[A-Za-z0-9_]*';

/**
 * Quoted values are always hidden. Unquoted ones are hidden unless they are plainly code
 * (a call, a member access, a number, a keyword), so `token = getToken()` or `tokens: 5`
 * reach the reviewer intact and quotes from those lines still match the file, while
 * `DB_PASSWORD=hunter2` or a YAML `password: hunter2` do not leave the machine.
 */
function maskAssignment(match, quote, name, sep, value) {
  const quoted = /^["']/.test(value);
  const looksLikeCode = value.includes('(') || /^[A-Za-z_$][\w$]*\.[\w$.]+$/.test(value)
    || /^\d+(\.\d+)?$/.test(value) || /^(true|false|null|undefined|none|nil)$/i.test(value);
  if (!quoted && looksLikeCode) return match;
  return `${quote}${name}${quote}${sep}${quoted ? `${value[0]}[REDACTED]${value[0]}` : '[REDACTED]'}`;
}

const PATTERNS = [
  // A key block cut short (a truncated diff, say) is hidden to the end of the text.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]'],
  [new RegExp(`(["']?)\\b(${SECRET_NAME})\\1(\\s*[:=]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;)"']+)`, 'gi'), maskAssignment],
  [/\b(Authorization\s*:\s*)(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, '$1$2 [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_TOKEN]'],
  [/\bya29\.[0-9A-Za-z._-]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
];

export function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

const SEP = '[\\\\/]';

// Files that never go into a packet, whatever the caller asks for.
const FORBIDDEN_FILE = new RegExp(`(^|${SEP})(${[
  '\\.env(\\..*)?', '\\.npmrc', '\\.netrc', '_netrc', '\\.pgpass', '\\.git-credentials',
  'id_[a-z0-9]+', '.*\\.pem', '.*\\.key', '.*\\.pfx', '.*\\.p12',
  'credentials(\\.json)?', '\\.credentials\\.json', 'auth\\.json', 'known_hosts(\\.old)?',
  'secrets?(\\.(json|ya?ml|toml|ini|txt))?',
].join('|')})$`, 'i');

const FORBIDDEN_DIR = new RegExp(
  `(^|${SEP})(\\.ssh|\\.gnupg|\\.aws|\\.azure|\\.kube|\\.docker|\\.codex|\\.gemini|\\.claude|\\.gauntlet|\\.git)(${SEP}|$)`, 'i');

export function isForbiddenPath(p) {
  return FORBIDDEN_FILE.test(p) || FORBIDDEN_DIR.test(p);
}

// What a provider child process inherits: enough to run, nothing secret-looking.
const ENV_ALLOW = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'PROGRAMW6432',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'TZ', 'USER', 'LOGNAME',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'CODEX_HOME',
]);
const ENV_SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE)/i;

export function childEnv(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_ALLOW.has(k) && !ENV_SECRETISH.test(k)) out[k] = v;
  }
  return { ...out, ...extra };
}
