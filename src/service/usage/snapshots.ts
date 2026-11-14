// Passive usage snapshots (P3-T15, PRD §5.11, FR-46..FR-48, EC-91, EC-92; design review 1088). Pure parts: quota
// readings from the Claude statusLine tee record and Codex token_count rate_limits, the minute history step, the
// read-time status, statusLine context and reported cost, usage scopes and the Codex account marker. Missing is a gap,
// never zero; nothing here asks an agent or a provider for anything (FR-44).
import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../../shared/log.ts';
import { utcMs } from '../time.ts';
import type { ContextObs } from './context.ts';
import { codexRateLimits } from './tokens.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const MIN = 60_000;
export const STALE_MS = 15 * MIN;
const SKEW_MS = 5 * MIN; // review L3: a source time this far after its observation is not trusted
const MAX_TS = Date.UTC(2100, 0, 1);
const range = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const percent = (v: unknown) => range(v, 0, 10_000); // spend above 100 % is kept (review L1 bound)
const minutes = (v: unknown) => (Number.isInteger(v) ? range(v, 1, 525_600) : null);
const instant = (ms: number) => (Number.isFinite(ms) && ms > 0 && ms <= MAX_TS ? ms : null);
/** Epoch seconds, or ISO with an offset (D-P3-11); anything else is unknown. */
const resetMs = (v: unknown) => (typeof v === 'number' ? instant(v * 1000) : typeof v === 'string' ? instant(utcMs(v)) : null);

export interface Reading {
  stream: string; usedPercent: number | null; windowMinutes: number | null; resetsAt: number | null;
  plan: string | null; credits: string | null; asOf: number | null;
}

const CLAUDE_WINDOWS: [string, number][] = [['five_hour', 300], ['seven_day', 10_080]];
/** The tee record's rate_limits (already allowlisted by the tee and again by intake). No source time (S13). */
export function claudeReadings(record: Obj): Reading[] {
  const rl = record['rate_limits'];
  if (!isObj(rl)) return [];
  return CLAUDE_WINDOWS.flatMap(([w, m]) => {
    const x = rl[w] === null ? {} : rl[w]; // an explicit null window: an all-null reading, a change from the old value (G3e-1)
    return isObj(x) ? [{ stream: w, usedPercent: percent(x['used_percentage']), windowMinutes: m, resetsAt: resetMs(x['resets_at']), plan: null, credits: null, asOf: null }] : [];
  });
}

/** token_count rate_limits; `asOf` is the record's own timestamp. */
export function codexReadings(rl: Obj, asOf: number | null): Reading[] {
  const r = codexRateLimits(rl);
  const credits = r.credits === null ? null : JSON.stringify(r.credits);
  return r.windows.map((w) => ({
    stream: `${r.limitId ?? '-'}:${w.kind}`, usedPercent: percent(w.usedPercent), windowMinutes: minutes(w.durationMinutes),
    resetsAt: w.resetsAt === null ? null : instant(w.resetsAt), plan: r.plan, credits, asOf,
  }));
}

export interface Stored extends Reading { firstObservedAt: number; measuredAt: number }
/** The reading's trusted source time: null when unknown or later than the observation + 5 min (review L3). */
export const sourceTime = (r: Reading, observedAt: number) => (r.asOf !== null && r.asOf <= observedAt + SKEW_MS ? r.asOf : null);
export type Step = { action: 'skip' } | { action: 'sample' | 'transition'; minute: number; measuredAt: number; firstObservedAt: number };

/** One reading against the stored reading just before it in measured time. An unchanged reading with no newer source
 *  time is skipped, so a re-emission never renews the measurement age; a changed reset, window or plan is a transition
 *  (kept apart from the one-per-minute samples); measured time = source time, else this first observation. */
export function historyStep(prev: Stored | null, r: Reading, observedAt: number): Step {
  const asOf = sourceTime(r, observedAt);
  if (prev && prev.usedPercent === r.usedPercent && prev.windowMinutes === r.windowMinutes && prev.resetsAt === r.resetsAt
    && prev.plan === r.plan && prev.credits === r.credits && (asOf === null || asOf === prev.asOf)) return { action: 'skip' };
  const measuredAt = asOf ?? observedAt;
  const transition = prev !== null && (prev.resetsAt !== r.resetsAt || prev.windowMinutes !== r.windowMinutes || prev.plan !== r.plan);
  return { action: transition ? 'transition' : 'sample', minute: Math.floor(measuredAt / MIN), measuredAt, firstObservedAt: observedAt };
}

export interface UsageStatus {
  state: 'current' | 'stale' | 'reset-passed' | 'unavailable'; usedPercent: number | null; resetsAt: number | null;
  measuredAt: number | null; sourceTimeKnown: boolean; label: string | null;
}
/** Read time only: local countdowns never call the agent. */
export function usageStatus(s: Stored | null, now: number): UsageStatus {
  if (!s) return { state: 'unavailable', usedPercent: null, resetsAt: null, measuredAt: null, sourceTimeKnown: false, label: 'No observation yet' };
  const known = s.asOf !== null;
  if (s.resetsAt !== null && now >= s.resetsAt) {
    return { state: 'reset-passed', usedPercent: null, resetsAt: s.resetsAt, measuredAt: s.measuredAt, sourceTimeKnown: known, label: 'Reset passed; awaiting observation' };
  }
  return { state: now - s.measuredAt > STALE_MS ? 'stale' : 'current', usedPercent: s.usedPercent, resetsAt: s.resetsAt, measuredAt: s.measuredAt,
    sourceTimeKnown: known, label: known ? null : `Source time unknown; observed ${new Date(s.firstObservedAt).toISOString()}` };
}
/** agy: quota is unavailable from the verified contract (FR-46). */
export const agyUsageStatus = (): UsageStatus =>
  ({ state: 'unavailable', usedPercent: null, resetsAt: null, measuredAt: null, sourceTimeKnown: false, label: 'Unavailable from passive sources' });

const tokens = (v: unknown) => range(v, 0, Number.MAX_SAFE_INTEGER);
/** Used = input + cache creation + cache read (output excluded, §5.11); null current_usage (before a reply, after
 *  /compact) = unavailable. The window is the reported one (FR-47). */
export function statuslineContext(record: Obj, locator: string): ContextObs | null {
  const cw = record['context_window'];
  if (!isObj(cw)) return null;
  const u = cw['current_usage'];
  const parts = isObj(u) ? [u['input_tokens'], u['cache_creation_input_tokens'], u['cache_read_input_tokens']].map(tokens) : [null];
  const model = isObj(record['model']) && typeof record['model']['id'] === 'string' ? record['model']['id'] : null;
  return { kind: 'statusline', model, window: tokens(cw['context_window_size']), used: parts.some((p) => p === null) ? null : parts.reduce<number>((n, p) => n + p!, 0), at: null, locator };
}
/** The agent-reported session estimate (§5.12); review L5 bound. */
export const statuslineCost = (record: Obj): number | null => (isObj(record['cost']) ? range(record['cost']['total_cost_usd'], 0, 1e6) : null);

/** Codex account epoch marker (§5.11 owner-approved exception; review M2): domain-separated HMAC under the install's
 *  secret salt, 128 bits. It says "same account marker", not "authentic" (review M3); never logged or sent over IPC. */
export const accountMarker = (salt: Buffer, id: string) => createHmac('sha256', salt).update('xaibo-usage-epoch-v1\0').update(id).digest('hex').slice(0, 32);

/** Claude has no account identifier: one unverified scope per session. Codex with a marker: one scope per profile and
 *  marker, across sessions. Profiles never merge. */
export function scopeKey(o: { profileId: string; agent: string; epoch: string | null; nativeSessionId: string }): { key: string; epoch: string | null; verified: boolean } {
  return o.epoch
    ? { key: JSON.stringify([o.profileId, o.agent, o.epoch, null]), epoch: o.epoch, verified: true }
    : { key: JSON.stringify([o.profileId, o.agent, null, o.nativeSessionId]), epoch: null, verified: false };
}

const SALT_FILE = 'usage-scope.salt';
const SALT_BYTES = 32;
function readSalt(file: string): Buffer | 'missing' | 'invalid' {
  let fd: number;
  // O_NONBLOCK: a FIFO never blocks boot, which calls this synchronously (G3e-2); fstat below still refuses it
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid'; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size !== SALT_BYTES) return 'invalid';
    const b = Buffer.alloc(SALT_BYTES);
    return readSync(fd, b, 0, SALT_BYTES, 0) === SALT_BYTES ? b : 'invalid';
  } finally {
    closeSync(fd);
  }
}
/** The install's secret salt, created once (0600 temp file, fsync, link: a reader never sees a partial file). A bad
 *  file is never replaced (that would silently split history): no epoch, and a content-free log code. */
export function loadScopeSalt(dataDir: string, log?: Logger): Buffer | null {
  const file = path.join(dataDir, SALT_FILE);
  let salt = readSalt(file);
  if (salt === 'missing') {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, randomBytes(SALT_BYTES)); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } // EEXIST: another writer won
      salt = readSalt(file);
    } catch {
      salt = 'invalid';
    } finally {
      try { unlinkSync(tmp); } catch { /* not created */ }
    }
  }
  if (typeof salt === 'string') { log?.log('usage_salt_invalid'); return null; }
  return salt;
}

export interface UsageStatusRow { profileId: string; agent: string; verified: boolean | null; stream: string | null; status: UsageStatus }
type Latest = { profile_id: string; agent: string; verified: number; limit_id: string; used_percent: number | null; window_minutes: number | null;
  resets_at: number | null; plan: string | null; credits: string | null; as_of: number | null; first_observed_at: number; measured_at: number };
/** The newest eligible measurement per scope and stream, plus an explicit unavailable row per agy profile.
 *  ponytail: the stream list comes from a scan of the history index; a streams table if histories grow large. */
export function usageStatusList(db: DatabaseSync, now: number): UsageStatusRow[] {
  const rows = db.prepare(`SELECT s.profile_id, s.agent, s.verified, h.limit_id, h.used_percent, h.window_minutes, h.resets_at, h.plan, h.credits,
      h.as_of, h.first_observed_at, h.measured_at
    FROM (SELECT DISTINCT usage_scope_id, limit_id FROM usage_history) k
    JOIN usage_history h ON h.id = (SELECT id FROM usage_history x WHERE x.usage_scope_id = k.usage_scope_id AND x.limit_id = k.limit_id
      ORDER BY x.measured_at DESC, x.id DESC LIMIT 1)
    JOIN usage_scopes s ON s.id = h.usage_scope_id
    ORDER BY s.profile_id, s.id, h.limit_id`).all() as Latest[];
  const out: UsageStatusRow[] = rows.map((r) => ({
    profileId: r.profile_id, agent: r.agent, verified: r.verified === 1, stream: r.limit_id,
    status: usageStatus({ stream: r.limit_id, usedPercent: r.used_percent, windowMinutes: r.window_minutes, resetsAt: r.resets_at, plan: r.plan,
      credits: r.credits, asOf: r.as_of, firstObservedAt: r.first_observed_at, measuredAt: r.measured_at }, now),
  }));
  for (const p of db.prepare("SELECT id FROM profiles WHERE agent = 'agy' ORDER BY id").all() as { id: string }[]) {
    out.push({ profileId: p.id, agent: 'agy', verified: null, stream: null, status: agyUsageStatus() });
  }
  return out;
}
