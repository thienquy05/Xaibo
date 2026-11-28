// XAIBO-PROD-615 (P7-T03, EC-84; design .handoff/p7-designs.md, Claude from the plan, D-P7-02): launch grants. A private record
// (<dataDir>/launch/grants.json, 0600 in a 0700 folder, written by temp file + rename, at most 1 MiB) holds one grant per agent
// id: the executable's realpath and sha256, the absolute interpreter its #! line names (realpath and sha256; ponytail: an
// env-style #! resolves from the launch PATH and is not bound, nor is any package tree behind the entry script), the argument
// template and the approved environment key names (never values). revalidate() runs immediately before each launch: no grant
// is "grant required"; any changed field is "renewal required" naming it; an unreadable or malformed record never grants.
// grantLaunch() records a grant only after main's native confirmation shows the executable path and template (P7-T04 wires
// the dialog: bundled catalog entries at first use, imported ones always explicitly; renewal shows what changed). The launched
// environment is a fixed set plus the granted key names only (the launch script, command.ts), so provider credentials never pass without an
// explicit grant (Q20). Never a shell evaluation or a package install. Observe-only (the service) never reads this file.
// Reviews (XAIBO-PROD-615): grantLaunch binds the fingerprint the dialog showed (taken before it opened; a swap while it was open
// is refused); revalidate returns the bound realpath, which P7-T04 checks is the argv[0] it launches; the environment filter is
// applied inside the .command script (command.ts) because Terminal does not inherit Xaibo's environment; the record is read
// only as a private regular file of ours. ponytail: same-user code can still rewrite the record or swap the executable after
// revalidation (no MAC); stated in the threat model, not hidden.
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AGENT_ID, ENV_KEY } from '../../shared/ipc.ts';
import { atomicWrite, privateDir } from '../../service/fs-private.ts';

export type Origin = 'bundled' | 'imported';
export interface LaunchSpec { exe: string; template: readonly string[]; envKeys: readonly string[] }
export interface Grant {
  exeReal: string; exeSha256: string; entry: { path: string; sha256: string } | null;
  template: string[]; envKeys: string[]; grantedAt: number; origin: Origin;
}
export type Field = 'exe' | 'exe-hash' | 'entry' | 'template' | 'env';
export type Check = { ok: true; exeReal: string } | { ok: false; blocked: 'grant required' } | { ok: false; blocked: 'renewal required'; field: Field };
export type Fingerprint = Pick<Grant, 'exeReal' | 'exeSha256' | 'entry'>;

const SHA = /^[0-9a-f]{64}$/;
const HASH_MAX = 512 * 1024 * 1024, RECORD_MAX = 1024 * 1024;
const uid = process.getuid?.();
const keySet = (keys: readonly string[]) => [...new Set(keys)].sort();
const recordFile = (dataDir: string) => path.join(dataDir, 'launch', 'grants.json');

/** Streaming sha256 of a regular file of at most HASH_MAX bytes; null otherwise. */
async function sha256(f: string): Promise<string | null> {
  const st = statSync(f);
  if (!st.isFile() || st.size > HASH_MAX) return null;
  const h = createHash('sha256');
  let n = 0;
  for await (const chunk of createReadStream(f) as AsyncIterable<Buffer>) {
    n += chunk.length;
    if (n > HASH_MAX) return null;
    h.update(chunk);
  }
  return h.digest('hex');
}
/** The interpreter a #! line names: none, an absolute path, env (resolved from the launch PATH: not bound) or a relative one
 *  (resolved against the launch cwd: never bound). The kernel reads at most 512 bytes. */
function shebang(f: string): { interp: string | null } | 'relative' {
  const fd = openSync(f, 'r');
  try {
    const b = Buffer.alloc(512), line = b.subarray(0, readSync(fd, b, 0, 512, 0)).toString('latin1').split('\n')[0]!;
    const interp = line.startsWith('#!') ? line.slice(2).trim().split(/\s+/)[0] : undefined;
    if (!interp) return { interp: null };
    if (!path.isAbsolute(interp)) return 'relative';
    return { interp: path.basename(interp) === 'env' ? null : interp };
  } finally { closeSync(fd); }
}
async function probe(exe: string): Promise<Fingerprint | Field> {
  let exeReal: string, exeSha256: string | null, bang;
  try {
    if (!path.isAbsolute(exe)) return 'exe';
    exeReal = realpathSync.native(exe);
    exeSha256 = await sha256(exeReal);
    bang = shebang(exeReal);
  } catch { return 'exe'; }
  if (!exeSha256 || bang === 'relative') return 'exe';
  if (!bang.interp) return { exeReal, exeSha256, entry: null };
  try {
    const p = realpathSync.native(bang.interp), s = await sha256(p);
    return s ? { exeReal, exeSha256, entry: { path: p, sha256: s } } : 'entry';
  } catch { return 'entry'; }
}
/** What the grant dialog shows and binds (taken before it opens); null when the executable cannot be bound. */
export async function fingerprint(exe: string): Promise<Fingerprint | null> { const p = await probe(exe); return typeof p === 'string' ? null : p; }

const strings = (v: unknown, ok: (s: string) => boolean): v is string[] => Array.isArray(v) && v.length <= 64 && v.every((s) => typeof s === 'string' && ok(s));
const tokenOk = (s: string) => s.length <= 4096 && !s.includes('\0');
function grantOf(v: unknown): Grant | null {
  if (typeof v !== 'object' || v === null) return null;
  const g = v as Record<string, unknown>, e = g['entry'] as Record<string, unknown> | null;
  const entryOk = e === null || (typeof e === 'object' && typeof e['path'] === 'string' && path.isAbsolute(e['path']) && typeof e['sha256'] === 'string' && SHA.test(e['sha256']));
  return typeof g['exeReal'] === 'string' && path.isAbsolute(g['exeReal']) && typeof g['exeSha256'] === 'string' && SHA.test(g['exeSha256']) && entryOk
    && strings(g['template'], tokenOk) && strings(g['envKeys'], (k) => ENV_KEY.test(k)) && Number.isFinite(g['grantedAt']) && (g['origin'] === 'bundled' || g['origin'] === 'imported')
    ? { exeReal: g['exeReal'], exeSha256: g['exeSha256'], entry: e === null ? null : { path: e['path'] as string, sha256: e['sha256'] as string },
      template: g['template'], envKeys: g['envKeys'], grantedAt: g['grantedAt'] as number, origin: g['origin'] } : null;
}

/** Every well-formed grant; a missing, oversized, linked, shared, foreign or unreadable record is none (never a grant). */
export function readGrants(dataDir: string): Record<string, Grant> {
  const out: Record<string, Grant> = {}; // keys pass AGENT_ID; lookups use Object.hasOwn (never a prototype key)
  try {
    const f = recordFile(dataDir), st = lstatSync(f);
    if (!st.isFile() || st.size > RECORD_MAX || (st.mode & 0o077) !== 0 || (uid !== undefined && st.uid !== uid)) return out;
    const all = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    if (typeof all !== 'object' || all === null || Array.isArray(all)) return out;
    for (const [agent, v] of Object.entries(all)) { const g = AGENT_ID.test(agent) ? grantOf(v) : null; if (g) out[agent] = g; }
  } catch { /* none */ }
  return out;
}

/** Records a grant after the owner confirmed `shown` (the dialog's fingerprint); throws when the spec cannot be bound or the
 *  executable no longer matches what was shown. ponytail: main is the only writer. */
export async function grantLaunch(dataDir: string, agent: string, spec: LaunchSpec, origin: Origin, shown: Fingerprint | null, now = Date.now()): Promise<Grant> {
  if (!AGENT_ID.test(agent) || !strings([...spec.template], tokenOk) || !strings([...spec.envKeys], (k) => ENV_KEY.test(k))) throw new Error('invalid launch grant');
  const fp = await fingerprint(spec.exe);
  if (!fp || !shown || !isDeepStrictEqual(fp, shown)) throw new Error('executable cannot be bound as shown');
  const g: Grant = { ...fp, template: [...spec.template], envKeys: keySet(spec.envKeys), grantedAt: now, origin };
  privateDir(dataDir);
  privateDir(path.dirname(recordFile(dataDir)));
  const all = { ...readGrants(dataDir), [agent]: g };
  const text = JSON.stringify(all);
  if (Buffer.byteLength(text) > RECORD_MAX) throw new Error('launch grants too large');
  atomicWrite(recordFile(dataDir), text, 0o600);
  return g;
}

/** Immediately before a launch: the grant, the executable (and its interpreter) as they are now, the template, the env keys. */
export async function revalidate(dataDir: string, agent: string, spec: LaunchSpec): Promise<Check> {
  const all = readGrants(dataDir), g = AGENT_ID.test(agent) && Object.hasOwn(all, agent) ? all[agent] : undefined;
  if (!g) return { ok: false, blocked: 'grant required' };
  const renew = (field: Field): Check => ({ ok: false, blocked: 'renewal required', field });
  if (!isDeepStrictEqual([...spec.template], g.template)) return renew('template');
  if (!isDeepStrictEqual(keySet(spec.envKeys), g.envKeys)) return renew('env');
  const fp = await probe(spec.exe);
  if (fp === 'exe' || (typeof fp !== 'string' && fp.exeReal !== g.exeReal)) return renew('exe');
  if (fp === 'entry') return renew('entry');
  if (typeof fp === 'string') return renew(fp);
  if (fp.exeSha256 !== g.exeSha256) return renew('exe-hash');
  return isDeepStrictEqual(fp.entry, g.entry) ? { ok: true, exeReal: g.exeReal } : renew('entry');
}

