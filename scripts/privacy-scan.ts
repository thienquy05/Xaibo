// Privacy scanner (P0-T08; stdlib only). Usage: privacy-scan.ts <paths…> | --stdin
// Flags absolute home paths, non-synthetic UUIDs, non-example emails, loopback ports, opaque identifiers,
// D-20 secret shapes and the current username/hostname. Prints `file:line pattern-id`, never the match.
// A line containing `privacy-scan:allow <reason>` is skipped (only for lines documenting these patterns).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build']);
const MIN_NAME_LEN = 3;
// privacy-scan:allow pattern list
const PATTERNS: [string, RegExp][] = [
  ['home-path', /(?<![A-Za-z0-9_.~-])(?:\/Users\/|\/private\/|\/home\/)|C:\\{1,2}Users\\{1,2}/i], // plain or JSON-escaped Windows
  ['uuid', /\b(?!00000000-0000-4000-8000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['email', /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net|invalid)\b)(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/],
  ['loopback-port', /(?:localhost|127\.0\.0\.1|\[::1\]):\d+/],
  ['secret-anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['secret-generic', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['secret-aws', /\bAKIA[0-9A-Z]{16}\b/],
  ['secret-github', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['secret-google', /\bAIza[0-9A-Za-z_-]{35}/],
  ['secret-slack', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['secret-jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['secret-bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['secret-pem', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['secret-userinfo', /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i],
];
const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/g;
const B64_RUN = /[A-Za-z0-9_-]{32,}/g;
// Field names like cacheCreationEphemeral5mInputTokens: lowercase start, each capital followed by lowercase/digits.
const CAMEL_CASE = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+$/;
const INTEGRITY_LINE = /^[+-]?\s*"integrity": "sha512-[A-Za-z0-9+/]+={0,2}",?\s*$/;
// A diff header that names only synthetic fixture files (their names carry synthetic ids); their content is still scanned.
const FIXTURE_HEADER = /^(diff --git a\/test\/fixtures\/synthetic\/\S+ b\/test\/fixtures\/synthetic\/\S+|(\+\+\+|---) [ab]\/test\/fixtures\/synthetic\/\S+)$/;

const gitObjects = new Map<string, boolean>();
function isGitObject(hex: string): boolean {
  if (hex.length !== 40 && hex.length !== 64) return false;
  if (!gitObjects.has(hex)) gitObjects.set(hex, spawnSync('git', ['cat-file', '-e', hex], { stdio: 'ignore' }).status === 0);
  return gitObjects.get(hex)!;
}

function opaque(line: string): boolean {
  if (INTEGRITY_LINE.test(line)) return false; // the one exemption, opaque rule only
  for (const m of line.match(HEX_RUN) ?? []) if (!isGitObject(m.toLowerCase())) return true;
  return (line.match(B64_RUN) ?? []).some((m) => /[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9]/.test(m) && !/^[0-9a-fA-F]+$/.test(m) && !CAMEL_CASE.test(m));
}

const names = [userInfo().username, hostname(), hostname().replace(/\.local$/, '')]
  .filter((n) => n.length >= MIN_NAME_LEN)
  .map((n) => new RegExp(`(?<![A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i'));

export function scanText(label: string, text: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes('privacy-scan:allow')) return;
    if (FIXTURE_HEADER.test(line)) return;
    const hits = PATTERNS.filter(([, re]) => re.test(line)).map(([id]) => id);
    if (opaque(line)) hits.push('opaque-id');
    if (names.some((re) => re.test(line))) hits.push('machine-name');
    for (const id of new Set(hits)) out.push(`${label}:${i + 1} ${id}`);
  });
  return out;
}

function files(p: string): string[] {
  const st = statSync(p);
  if (!st.isDirectory()) return [p];
  return readdirSync(p).filter((e) => !SKIP_DIRS.has(e)).flatMap((e) => files(path.join(p, e)));
}

function main(args: string[]): number {
  if (args.length === 0) { console.log('usage: privacy-scan.ts <paths…> | --stdin'); return 2; }
  const findings = args[0] === '--stdin'
    ? scanText('<stdin>', readFileSync(0, 'utf8'))
    : args.flatMap(files).flatMap((f) => {
      const buf = readFileSync(f);
      return buf.includes(0) ? [] : scanText(path.relative(process.cwd(), f) || f, buf.toString('utf8'));
    });
  for (const f of findings) console.log(f);
  return findings.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
