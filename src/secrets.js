export const MAX_BYTES = 1024 * 1024;

const KEY_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];
const NAME_WORDS = ['secret', 'credential', 'creds', 'password'];

export function nameReason(filePath) {
  const base = filePath.split('/').pop().toLowerCase();
  const isEnv = base === '.env' || (base.startsWith('.env.') && base !== '.env.example' && base !== '.env.sample');
  const isKey = KEY_EXTENSIONS.some((ext) => base.endsWith(ext)) || base.startsWith('id_rsa') || base.startsWith('id_ed25519');
  if (isEnv || isKey || NAME_WORDS.some((w) => base.includes(w))) return 'secret-looking file name';
  return null;
}

const CONTENT_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'contains a private key'],
  [/AKIA[0-9A-Z]{16}/, 'contains an AWS key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'contains a GitHub token'],
  [/xox[abpr]-[A-Za-z0-9-]{10,}/, 'contains a Slack token'],
  [/sk-[A-Za-z0-9_-]{20,}/, 'contains an API key'],
  [/(api[_-]?key|secret|token|passw(or)?d)\s*[:=]\s*['"]?[^\s'"]{8,}/i, 'contains a key, token or password value'],
];

export function contentReason(buf) {
  if (buf.subarray(0, 8000).includes(0)) return null;
  const text = buf.toString('utf8');
  const hit = CONTENT_RULES.find(([re]) => re.test(text));
  return hit ? hit[1] : null;
}

// One glob per line. A pattern with a slash is anchored at the repo root, otherwise it matches a name at any depth.
export function parseIgnore(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map(globToRegExp);
}

function globToRegExp(glob) {
  let g = glob.replace(/\/+$/, '');
  const anchored = g.includes('/');
  g = g.replace(/^\//, '');
  const body = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?$`);
}

export function ignoreReason(filePath, ignoreRegexps) {
  return ignoreRegexps.some((re) => re.test(filePath)) ? 'listed in .airspaceignore' : null;
}

export function sizeReason(size) {
  return size > MAX_BYTES ? 'larger than 1 MB' : null;
}

// Cheap checks first; the caller only reads the content when the others pass.
export function pathReason(filePath, ignoreRegexps = []) {
  return ignoreReason(filePath, ignoreRegexps) ?? nameReason(filePath);
}
