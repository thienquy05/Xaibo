// XAIBO-PROD-517 (P5-T09; FR-12, US-6, Q-5.5, EC-22, EC-42): the session retention policy. The setting is integer days
// 1-3650 or Never, default 45; a session is eligible N x 24 h of elapsed time after its last activity unless it is kept,
// in Trash (its own 30-day timer), live, or active within the last 24 h. Elapsed milliseconds only: no zone or DST.
import type { DatabaseSync } from 'node:sqlite';
import type { LiveStatus } from '../../shared/ipc.ts';

export const DAY = 24 * 3600_000;
export const RETENTION_DEFAULT = 45;
const RETENTION_MAX = 3650;
/** No automatic purge of a session active within this (EC-22). */
export const RECENT_MS = DAY;
/** Account-level usage history expires this long after its measurement (§5.11). */
export const QUOTA_MS = 45 * DAY;
const KEY = 'retention.sessions';

export type Retention = { days: number } | 'never';

export function parseRetention(v: unknown): Retention | null {
  if (v === 'never') return 'never';
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= RETENTION_MAX ? { days: v } : null;
}

/** The stored setting; the default only when none is stored. An unreadable stored value is null (review M1): no session
 *  retention runs on it, so a garbled or future-format "never" cannot purge history the owner chose to keep. */
export function retentionOf(db: DatabaseSync): Retention | null {
  const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!r) return { days: RETENTION_DEFAULT };
  if (r.value === 'never') return 'never';
  return /^[1-9]\d{0,3}$/.test(r.value) ? parseRetention(Number(r.value)) : null;
}

/** Stores a valid setting; false (nothing stored) for anything else. */
export function setRetention(db: DatabaseSync, v: unknown): boolean {
  const r = parseRetention(v);
  if (!r) return false;
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(KEY, r === 'never' ? 'never' : String(r.days));
  return true;
}

/** When retention makes the session eligible (US-6 "Purge scheduled"); null for Never or unknown activity. */
export const purgeAt = (lastActivity: number | null, r: Retention): number | null => (r === 'never' || lastActivity === null ? null : lastActivity + r.days * DAY);

export interface Candidate { lastActivity: number | null; keep: boolean; trashed: boolean; active: boolean }
/** EC-22: never kept, in Trash, live or recently active sessions; activity in the future (a clock set back) never. */
export function eligible(c: Candidate, r: Retention, now: number): boolean {
  const at = purgeAt(c.lastActivity, r);
  return at !== null && c.lastActivity !== null && !c.keep && !c.trashed && !c.active && now - c.lastActivity >= RECENT_MS && at <= now;
}

/** Live states retention never purges (EC-22). */
export const isActive = (lifecycle: LiveStatus['lifecycle'] | null): boolean =>
  lifecycle === 'busy' || lifecycle === 'waiting-for-permission' || lifecycle === 'needs-input';

/** Review H3: the wall clock moved more than 1 h further than the monotonic clock (set ahead). */
export const clockJumped = (from: { wall: number; mono: number }, to: { wall: number; mono: number }): boolean =>
  (to.wall - from.wall) - (to.mono - from.mono) > 3600_000;
