// sanitize() for every egress path (P1-T03; EC-33, EC-35): masks recognized credential formats, values of secret-like
// keys and emails, and maps home paths to ~. Idempotent. Best effort: it only knows the shapes in secret-patterns.ts
// and the key names below, so egress paths also avoid carrying content in the first place (content-free logs).
import { homedir } from 'node:os';
import { PATTERNS } from './secret-patterns.ts';

const MASKED = PATTERNS.filter(([id]) => id.startsWith('secret-') || id === 'email')
  .map(([id, re]) => [new RegExp(re.source, `${re.flags}g`), `[REDACTED:${id}]`] as const);

// key=value / "key": value with a secret-like key name; `token(?!s)` keeps token counts such as input_tokens.
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|secret|token(?!s)|api[_-]?key|apikey|authorization|cookie|private[_-]?key|credential)[A-Za-z0-9_.-]*`;
const KEY_VALUE = new RegExp(String.raw`(["']?)(${SECRET_KEY})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}&]+)`, 'gi');

const OTHER_HOMES = [
  /(?<![\w.~-])\/(?:Users|home)\/[^/\s"'\\]+/g,
  /(?<!\w)[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"']+/g, // plain or JSON-escaped Windows
];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function sanitize(text: string, home = homedir()): string {
  let out = text;
  for (const [re, mask] of MASKED) out = out.replace(re, mask);
  out = out.replace(KEY_VALUE, (_m, q: string, key: string, sep: string, value: string) =>
    `${q}${key}${q}${sep}${value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : '[REDACTED]'}`);
  if (home.length > 1) out = out.replace(new RegExp(`${escape(home)}(?=[\\\\/"'\\s]|$)`, 'g'), '~');
  for (const re of OTHER_HOMES) out = out.replace(re, '~');
  return out;
}
