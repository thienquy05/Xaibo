// Privacy scanner (P0-T08, P1-T02; stdlib only).
// Usage: privacy-scan.ts <paths…> | --stdin | --staged (index) | --all (tracked files) | --history (every commit)
// Flags absolute home paths, non-synthetic UUIDs, non-example emails, loopback ports, opaque identifiers,
// D-20 secret shapes and the current username/hostname. Prints `file:line pattern-id`, never the match.
// A line containing `privacy-scan:allow <reason>` is skipped (only for lines documenting these patterns).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { PATTERNS } from '../src/shared/secret-patterns.ts'; // the one list, shared with sanitize()

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build']);
const MIN_NAME_LEN = 3;
const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/g;
const B64_RUN = /[A-Za-z0-9_-]{32,}/g;
// Field names like cacheCreationEphemeral5mInputTokens: lowercase start, each capital followed by lowercase/digits.
const CAMEL_CASE = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+$/;
const INTEGRITY_LINE = /^[+-]?\s*"integrity": "sha512-[A-Za-z0-9+/]+={0,2}",?\s*$/;
// Email rule only: the required commit co-author trailer, and npm deprecation notices (maintainers' public addresses).
const EMAIL_EXEMPT = /^\s*Co-Authored-By: [^<>]+ <noreply@anthropic\.com>\s*$|^[+-]?\s*"deprecated": "/;
// Reviewed --history findings in commits that cannot change (one `history:<sha12> <file> <id>` per line, `#` comments).
const HISTORY_ALLOW = path.join(import.meta.dirname, 'privacy-history.allow');
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

export const nameMatchers = (list: string[]) => list
  .filter((n) => n.length >= MIN_NAME_LEN)
  .map((n) => new RegExp(`(?<![A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i'));
// On GitHub Actions the user and host are the runner's (`runner`, a common word), never the owner's; the owner's
// names are caught on the owner's machine (pre-commit --staged, gate scans). Every other rule still runs there.
const ON_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const MACHINE = ON_GITHUB_ACTIONS ? [] : nameMatchers([userInfo().username, hostname(), hostname().replace(/\.local$/, '')]);

export function scanText(label: string, text: string, names = MACHINE): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes('privacy-scan:allow')) return;
    if (FIXTURE_HEADER.test(line)) return;
    const hits = PATTERNS.filter(([id, re]) => re.test(line) && !(id === 'email' && EMAIL_EXEMPT.test(line))).map(([id]) => id);
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

export function git(args: string[]): Buffer {
  const r = spawnSync('git', args, { maxBuffer: 2 ** 31 - 1 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
}
export const nulList = (buf: Buffer) => buf.toString('utf8').split('\0').filter(Boolean);
const scanBuf = (label: string, buf: Buffer) => (buf.includes(0) ? [] : scanText(label, buf.toString('utf8')));

// Staged blobs (what the commit will contain), not the working tree.
const staged = () => nulList(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']))
  .flatMap((f) => scanBuf(f, git(['show', `:${f}`])));

const tracked = () => nulList(git(['ls-files', '-z']))
  .filter((f) => existsSync(f) && statSync(f).isFile())
  .flatMap((f) => scanBuf(f, readFileSync(f)));

// Every commit's message and patch; findings are `history:<sha12> <file> <id>`, deduplicated.
function history(): string[] {
  const out = new Set<string>();
  for (const commit of git(['log', '-p', '--all', '--no-color', '--format=%x00commit %H%n%B']).toString('utf8').split('\0')) {
    const sha = commit.slice('commit '.length, 'commit '.length + 12);
    for (const section of commit.split(/^(?=diff --git )/m)) {
      const head = section.slice(0, section.indexOf('\n'));
      const file = head.startsWith('diff --git ') ? head.slice(head.lastIndexOf(' b/') + 3) : '(message)';
      for (const hit of scanText(file, section)) out.add(`history:${sha} ${file} ${hit.slice(hit.lastIndexOf(' ') + 1)}`);
    }
  }
  const allowed = new Set(existsSync(HISTORY_ALLOW)
    ? readFileSync(HISTORY_ALLOW, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
    : []);
  return [...out].filter((f) => !allowed.has(f));
}

function main(args: string[]): number {
  if (args.length === 0) { console.log('usage: privacy-scan.ts <paths…> | --stdin | --staged | --all | --history'); return 2; }
  if (ON_GITHUB_ACTIONS) console.error('privacy-scan: machine-name rule is off on GitHub Actions (runner names are not the owner\'s)');
  const mode: Record<string, () => string[]> = {
    '--stdin': () => scanText('<stdin>', readFileSync(0, 'utf8')),
    '--staged': staged,
    '--all': tracked,
    '--history': history,
  };
  const findings = mode[args[0]!]?.() ?? args.flatMap(files).flatMap((f) => scanBuf(path.relative(process.cwd(), f) || f, readFileSync(f)));
  for (const f of findings) console.log(f);
  return findings.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
