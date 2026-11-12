// Report registrations (P3-T13b; PRD §5.10, SEC2; security review 872). Each registration binds one agent and profile to
// its own token; only the token's sha256 is stored, in <dataDir>/registrations.json (0600, atomic O_EXCL temp + rename).
// The file is opened without following links and checked on the open fd (regular, own uid, <= 1 MiB) before it is read,
// and anything malformed counts as no registrations for the socket. The registry re-reads it only when its identity
// changes (inode, size, mtime), so a bad hello costs one open and fstat; an unknown id is compared against a dummy hash,
// so it takes the same path and code as a bad token. Written only by the dev CLI (register/revoke).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, writeSync, type Stats } from 'node:fs';
import path from 'node:path';
import { AGENT, PROFILE, UUID } from '../../shared/hook-protocol.ts';

export interface Registration { id: string; agent: string; profile_key: string; token_sha256: string; created_at: number }
export interface Registry {
  /** The registration whose token this is, or null (unknown id or wrong token alike). */
  verify(id: string, token: string): Registration | null;
  /** The registration as currently stored (null once revoked). */
  current(id: string): Registration | null;
}
export class RegistrationError extends Error {
  readonly code: 'invalid' | 'unreadable' | 'full';
  constructor(code: RegistrationError['code']) {
    super(`registration refused: ${code}`);
    this.code = code;
  }
}

const FILE = 'registrations.json';
const MAX_BYTES = 1 << 20;
const MAX_REGISTRATIONS = 64;
const HEX64 = /^[0-9a-f]{64}$/;
const KEYS = ['id', 'agent', 'profile_key', 'token_sha256', 'created_at'];
const DUMMY = Buffer.alloc(32);
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const uid = () => process.getuid?.();
const stampOf = (st: Stats) => `${st.ino}:${st.size}:${st.mtimeMs}`;

function valid(x: unknown): x is Registration {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  return Object.keys(r).length === KEYS.length && KEYS.every((k) => Object.hasOwn(r, k))
    && typeof r['id'] === 'string' && UUID.test(r['id']) && typeof r['agent'] === 'string' && AGENT.test(r['agent'])
    && typeof r['profile_key'] === 'string' && PROFILE.test(r['profile_key'])
    && typeof r['token_sha256'] === 'string' && HEX64.test(r['token_sha256']) && Number.isSafeInteger(r['created_at']);
}

/** Opens the file (link not followed): null when absent; otherwise the fd and its stat. */
function open(dataDir: string): { fd: number; st: Stats } | null {
  let fd: number;
  try { fd = openSync(path.join(dataDir, FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return { fd, st: fstatSync(fd) };
}

/** [] when absent; null when present but not ours, too large or not valid. */
function load(dataDir: string): { regs: Registration[] | null; stamp: string } {
  let f;
  try { f = open(dataDir); } catch { return { regs: null, stamp: 'error' }; }
  if (!f) return { regs: [], stamp: 'none' };
  try {
    const { fd, st } = f;
    if (!st.isFile() || (uid() !== undefined && st.uid !== uid()) || st.size > MAX_BYTES) return { regs: null, stamp: stampOf(st) };
    const buf = Buffer.alloc(st.size);
    for (let n = 0; n < buf.length;) { const got = readSync(fd, buf, n, buf.length - n, null); if (!got) break; n += got; }
    try {
      const x: unknown = JSON.parse(buf.toString('utf8'));
      return { regs: Array.isArray(x) && x.length <= MAX_REGISTRATIONS && x.every(valid) ? x : null, stamp: stampOf(st) };
    } catch { return { regs: null, stamp: stampOf(st) }; }
  } finally { closeSync(f.fd); }
}

function save(dataDir: string, regs: Registration[]) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dataDir, `.registrations.${randomUUID()}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, JSON.stringify(regs)); fchmodSync(fd, 0o600); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path.join(dataDir, FILE));
  const d = openSync(dataDir, constants.O_RDONLY); // the rename itself durable (review L10)
  try { fsyncSync(d); } finally { closeSync(d); }
}

function stored(dataDir: string): Registration[] {
  const { regs } = load(dataDir);
  if (!regs) throw new RegistrationError('unreadable'); // never overwrite a file we cannot read as ours
  return regs;
}

/** Adds a registration; the token is returned once and only its hash is kept. ponytail: one writer (the dev CLI). */
export function addRegistration(dataDir: string, o: { agent: string; profileKey: string }, now: () => number = Date.now): { registration: Registration; token: string } {
  if (!AGENT.test(o.agent) || !PROFILE.test(o.profileKey)) throw new RegistrationError('invalid');
  const regs = stored(dataDir);
  if (regs.length >= MAX_REGISTRATIONS) throw new RegistrationError('full');
  const token = randomBytes(32).toString('base64url');
  const registration: Registration = { id: randomUUID(), agent: o.agent, profile_key: o.profileKey, token_sha256: sha256(token).toString('hex'), created_at: now() };
  save(dataDir, [...regs, registration]);
  return { registration, token };
}

/** Revokes a registration: new hellos fail at once and its open connections are cut at their next frame. */
export function removeRegistration(dataDir: string, id: string): boolean {
  const regs = stored(dataDir);
  const rest = regs.filter((r) => r.id !== id);
  if (rest.length === regs.length) return false;
  save(dataDir, rest);
  return true;
}

export function openRegistry(dataDir: string): Registry {
  let cache = { stamp: '', regs: [] as Registration[] };
  const list = () => {
    let stamp = 'error';
    try { const f = open(dataDir); if (f) { stamp = stampOf(f.st); closeSync(f.fd); } else stamp = 'none'; } catch { /* unreadable: re-read below */ }
    if (stamp === 'error' || stamp !== cache.stamp) { const l = load(dataDir); cache = { stamp: l.stamp, regs: l.regs ?? [] }; }
    return cache.regs;
  };
  return {
    verify(id, token) {
      const r = list().find((x) => x.id === id) ?? null;
      const ok = timingSafeEqual(sha256(token), r ? Buffer.from(r.token_sha256, 'hex') : DUMMY);
      return ok && r ? r : null;
    },
    current: (id) => list().find((x) => x.id === id) ?? null,
  };
}
