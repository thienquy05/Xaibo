// P0-T04 real-profile guard: detection only. Hashes real agent config files, stats credential files and
// hashes keychain metadata into a private manifest under .cache/guard/. Never lists or reads session stores.
// Output is category counts only, never names. Usage:
//   node spikes/shared/guard.ts snapshot <label>
//   node spikes/shared/guard.ts compare <label> [--expect-new-keychain <svce>]
//   node spikes/shared/guard.ts accept-unmatched <label>   (after the owner checked the items in Keychain Access)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface KeychainItem { svce: string; acct: string; mdat: string }
export type EnvKey = 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | 'GEMINI_CLI_HOME';
export interface GuardCtx {
  home: string;
  env: Partial<Record<EnvKey, string | string[]>>;
  keychain: () => KeychainItem[];
}
type Cat = 'config' | 'credential';
interface Snapshot {
  version: 1;
  files: Record<string, { cat: Cat; fp: string | null }>;
  keychain: { s: string; a: string; m: string; agent: boolean }[];
}
export interface CompareOpts { expectNew?: string; nonAgent?: Set<string> }
type Counts = { config: number; credential: number; keychain: number; unmatched: number; expectedNew: number };

const AGENT_SVCE = /laude|odex|emini|ntigravity|jetski/i; // jetski: agy's internal name (P2-T00)
const ENV_KEYS: EnvKey[] = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME'];
const LOGIN_ENV_TIMEOUT_MS = 3_000;
const DUMP_MAX_BYTES = 256 * 2 ** 20;
const QUIET: ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore']; // child stderr could carry names or paths

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const list = (v: string | string[] | undefined) => (v === undefined ? [] : [v].flat());
const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x).map((x) => path.resolve(x)))];

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}

function statOrNull(p: string) {
  try { return lstatSync(p); } catch { return null; }
}

function configFp(p: string): string | null {
  const st = statOrNull(p);
  return st ? `${sha(readFileSync(p))}:${st.ino}` : null;
}

function credentialFp(p: string): string | null {
  const st = statOrNull(p);
  return st ? `${st.size}:${st.mtimeMs}:${st.ino}` : null; // stat only, content never read
}

// The controlling Claude session rewrites ~/.claude.json, so only its key set and mcpServers count.
function claudeJsonFp(p: string): string | null {
  if (!statOrNull(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    return sha(JSON.stringify([Object.keys(j).sort(), stable(j.mcpServers ?? null)]));
  } catch {
    return 'unparseable'; // ponytail: a mid-write read shows as DIFF; the owner adjudicates
  }
}

// Plugins tree: names only (owner decision D-P0-18). A new or removed marketplace/plugin (depth <= 2) is a DIFF;
// content updates, version folders and refresh churn from the owner's running Claude Code are not.
function treeFp(dir: string): string | null {
  if (!statOrNull(dir)) return null;
  const names: string[] = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const rel = path.relative(dir, path.join(e.parentPath, e.name));
    const parts = rel.split(path.sep);
    if (parts.length === 1 || (parts.length <= 3 && ['cache', 'marketplaces'].includes(parts[0]))) names.push(rel);
  }
  return sha(names.sort().join('\n'));
}

// known_marketplaces.json: the set of marketplace names; refresh timestamps inside are ignored (D-P0-18).
function keySetFp(p: string): string | null {
  if (!statOrNull(p)) return null;
  try { return sha(JSON.stringify(Object.keys(JSON.parse(readFileSync(p, 'utf8')) as object).sort())); } catch { return 'unparseable'; }
}

export function takeSnapshot(ctx: GuardCtx): Snapshot {
  const { home, env } = ctx;
  const files: Snapshot['files'] = {};
  const add = (p: string, cat: Cat, fp: (p: string) => string | null) => { files[p] = { cat, fp: fp(p) }; };
  const claude = uniq([path.join(home, '.claude'), ...list(env.CLAUDE_CONFIG_DIR)]);
  const codex = uniq([path.join(home, '.codex'), ...list(env.CODEX_HOME)]);
  const gemini = uniq([path.join(home, '.gemini'), ...list(env.GEMINI_CLI_HOME).map((g) => path.join(g, '.gemini'))]);
  for (const r of claude) {
    for (const f of ['settings.json', 'settings.local.json', 'plugins/installed_plugins.json']) add(path.join(r, f), 'config', configFp);
    add(path.join(r, 'plugins/known_marketplaces.json'), 'config', keySetFp);
    add(path.join(r, '.credentials.json'), 'credential', credentialFp);
    add(path.join(r, 'plugins'), 'config', treeFp);
    add(path.join(r, '.claude.json'), 'config', claudeJsonFp);
  }
  add(path.join(home, '.claude.json'), 'config', claudeJsonFp);
  for (const r of codex) {
    for (const f of ['config.toml', 'hooks.json']) add(path.join(r, f), 'config', configFp);
    add(path.join(r, 'auth.json'), 'credential', credentialFp);
  }
  for (const r of gemini) {
    // agy config (P2-T00, from the binary's strings) lives under the same ~/.gemini root.
    for (const f of ['settings.json', 'config/config.json', 'config/hooks.json', 'antigravity-cli/settings.json']) add(path.join(r, f), 'config', configFp);
    add(path.join(r, 'oauth_creds.json'), 'credential', credentialFp);
    add(path.join(r, 'antigravity-cli/antigravity-oauth-token'), 'credential', credentialFp); // agy file store (P2-T00)
    add(path.join(r, 'gemini-credentials.json'), 'credential', credentialFp);
  }
  const keychain = ctx.keychain().map((k) => ({ s: sha(k.svce), a: sha(k.acct), m: k.mdat, agent: AGENT_SVCE.test(k.svce) }));
  return { version: 1, files, keychain };
}

function keychainChanges(base: Snapshot, cur: Snapshot) {
  const key = (k: Snapshot['keychain'][number]) => `${k.s}|${k.a}`;
  const b = new Map(base.keychain.map((k) => [key(k), k]));
  const c = new Map(cur.keychain.map((k) => [key(k), k]));
  const out: { s: string; agent: boolean; added: boolean }[] = [];
  for (const id of new Set([...b.keys(), ...c.keys()])) {
    const x = b.get(id);
    const y = c.get(id);
    if (x && y && x.m === y.m) continue;
    out.push({ s: (y ?? x)!.s, agent: !!(x?.agent || y?.agent), added: !x });
  }
  return out;
}

export function compareSnapshots(base: Snapshot, cur: Snapshot, opts: CompareOpts = {}): { counts: Counts; exit: number } {
  const counts: Counts = { config: 0, credential: 0, keychain: 0, unmatched: 0, expectedNew: 0 };
  for (const p of new Set([...Object.keys(base.files), ...Object.keys(cur.files)])) {
    const x = base.files[p];
    const y = cur.files[p];
    if ((x?.fp ?? null) !== (y?.fp ?? null)) counts[(y ?? x)!.cat]++;
  }
  const expected = opts.expectNew === undefined ? null : sha(opts.expectNew);
  for (const ch of keychainChanges(base, cur)) {
    if (ch.added && ch.s === expected && counts.expectedNew === 0) { counts.expectedNew = 1; continue; }
    if (ch.agent) counts.keychain++;
    else if (!opts.nonAgent?.has(ch.s)) counts.unmatched++;
  }
  const diff = counts.config + counts.credential + counts.keychain > 0;
  return { counts, exit: diff || counts.unmatched > 0 ? 1 : 0 };
}

export function unmatchedServices(base: Snapshot, cur: Snapshot): string[] {
  return [...new Set(keychainChanges(base, cur).filter((c) => !c.agent).map((c) => c.s))];
}

export function formatResult({ counts: c }: { counts: Counts }): string[] {
  const tail = [...(c.unmatched ? [`unmatched-change ${c.unmatched}`] : []), ...(c.expectedNew ? ['expected-new 1'] : [])];
  if (c.config + c.credential + c.keychain > 0) return [`DIFF: config ${c.config} / credential ${c.credential} / keychain ${c.keychain}`, ...tail];
  return c.unmatched ? tail : ['MATCH', ...tail];
}

// `security dump-keychain` without -d prints attributes only; keep generic-password svce/acct/mdat.
export function parseDumpKeychain(text: string): KeychainItem[] {
  const items: KeychainItem[] = [];
  let cur: (KeychainItem & { genp: boolean }) | null = null;
  const flush = () => { if (cur?.genp) items.push({ svce: cur.svce, acct: cur.acct, mdat: cur.mdat }); };
  for (const line of text.split('\n')) {
    if (line.startsWith('keychain:')) { flush(); cur = { svce: '', acct: '', mdat: '', genp: false }; continue; }
    if (!cur) continue;
    if (line.startsWith('class:')) { cur.genp = line.includes('"genp"'); continue; }
    const m = /^\s+"(svce|acct|mdat)"<\w+>=(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2].trim();
    const q = /^(?:0x[0-9A-Fa-f]+\s+)?"(.*)"$/.exec(raw);
    cur[m[1] as 'svce' | 'acct' | 'mdat'] = raw === '<NULL>' ? '' : q ? q[1] : raw;
  }
  flush();
  return items;
}

// Real agent roots from the fixed-argv login-shell env read (OQ-P1-03) and this process's env; both count.
export function readRootEnv(): Record<EnvKey, string[]> {
  const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-l', '-c', '/usr/bin/env -0'], { timeout: LOGIN_ENV_TIMEOUT_MS, encoding: 'utf8', stdio: QUIET });
  const login = new Map(out.split('\0').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const env = {} as Record<EnvKey, string[]>;
  for (const k of ENV_KEYS) env[k] = [login.get(k), process.env[k]].filter((v): v is string => !!v);
  return env;
}

function realCtx(): GuardCtx {
  return {
    home: os.homedir(),
    env: readRootEnv(),
    keychain: () => {
      const kc = /"(.*)"/.exec(execFileSync('/usr/bin/security', ['login-keychain'], { encoding: 'utf8', stdio: QUIET }))?.[1];
      if (!kc) throw Object.assign(new Error('no login keychain'), { code: 'ENOKEYCHAIN' });
      return parseDumpKeychain(execFileSync('/usr/bin/security', ['dump-keychain', kc], { encoding: 'utf8', maxBuffer: DUMP_MAX_BYTES, stdio: QUIET }));
    },
  };
}

function main(argv: string[]): number {
  const [cmd, label, flag, svce] = argv;
  if (!label || !/^[A-Za-z0-9._-]+$/.test(label) || !['snapshot', 'compare', 'accept-unmatched'].includes(cmd)) {
    console.log('usage: guard.ts snapshot|compare|accept-unmatched <label> [--expect-new-keychain <svce>]');
    return 2;
  }
  const dir = path.join(import.meta.dirname, '..', '..', '.cache', 'guard');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (n: string) => path.join(dir, `${n}.json`);
  const write = (n: string, v: unknown) => writeFileSync(file(n), JSON.stringify(v), { mode: 0o600 });
  const read = <T>(n: string): T => JSON.parse(readFileSync(file(n), 'utf8')) as T;
  const nonAgent = new Set<string>(existsSync(file('non-agent')) ? read<string[]>('non-agent') : []);
  if (cmd === 'snapshot') { write(label, takeSnapshot(realCtx())); console.log('snapshot ok'); return 0; }
  if (cmd === 'accept-unmatched') {
    const marked = unmatchedServices(read(label), read(`${label}.last`)).filter((s) => !nonAgent.has(s));
    write('non-agent', [...nonAgent, ...marked]);
    console.log(`marked ${marked.length}`);
    return 0;
  }
  const cur = takeSnapshot(realCtx());
  write(`${label}.last`, cur);
  const r = compareSnapshots(read(label), cur, { expectNew: flag === '--expect-new-keychain' ? svce : undefined, nonAgent });
  for (const l of formatResult(r)) console.log(l);
  return r.exit;
}

if (import.meta.main) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    console.log(`guard error ${(e as { code?: string }).code ?? 'unknown'}`); // no message: it may contain paths
    process.exitCode = 2;
  }
}
