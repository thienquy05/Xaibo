// XAIBO-PROD-519 (P5-T12; EC-23, EC-24, FR-13): native availability for Claude and Codex, checked on every adapter scan
// independently of Xaibo retention (agy has its own folder-level check, EC-81). Availability lives on the session only:
// a session not seen by discovery whose known main files are all confirmed missing (lstat ENOENT; anything else is never
// proof) reads native deleted; seen again, it is available. A session counts as present when a listed main file carries
// its id or one of its known paths is listed (security review M1: a file name id can differ from the session id; a Codex
// archive move keeps the id). Checkpoints are never touched (review M2/L1: coverage status and the epoch guard stay
// intact). One transaction per scan (review M3). Xaibo rows are never deleted; native paths are only stat-ed.
// The Claude cleanup estimate: newest transcript checkpoint mtime + effective cleanupPeriodDays x 24 h. S9 left Claude's
// age basis (mtime vs last record) unverified, so it is an estimate.
import { readdirSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CLAUDE_MANAGED_DIR, settings } from '../adapters/claude/hooks.ts';
import type { Writer } from '../store/writer.ts';

const DAY = 86_400_000;
const MAX_DATE = 8.64e15; // the JS Date range (review L3)
const STAT_CHUNK = 32;
/** Claude Code's cleanupPeriodDays when unset (PRD EC-23: 30-day agent default). */
export const CLAUDE_CLEANUP_DEFAULT = 30;

const enoent = async (p: string) => { try { await lstat(p); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT'; } };

/** One scan's reconcile: `files` is what discovery listed; `kinds` are the file kinds that hold a native session (not
 *  subagent files). Changes only native_available, in one transaction, and only where it changes. */
export async function reconcileNative(o: { db: DatabaseSync; writer: Writer; profileId: string; agent: string; kinds: string[] },
  files: { path: string; kind: string; sessionId: string }[]): Promise<void> {
  const main = files.filter((f) => o.kinds.includes(f.kind));
  const listed = new Set(main.map((f) => f.path)), ids = new Set(main.map((f) => f.sessionId));
  // ponytail: one scan of this profile's main-file checkpoints per pass (no (profile_id, kind) index); add one if M13 shows it.
  // ponytail (re-review LOW-2/LOW-3): an unmounted profile root reads every session deleted until it is back; an id-mismatched
  // rollout moved to archived_sessions/ reads deleted for one scan. Both heal on the next scan; a root check if they matter.
  const known = o.db.prepare(`SELECT f.path, s.native_session_id AS sid, s.native_available AS avail FROM source_files f JOIN sessions s ON s.id = f.session_id
    WHERE f.profile_id = ? AND s.agent = ? AND f.kind IN (SELECT value FROM json_each(?))`).all(o.profileId, o.agent, JSON.stringify(o.kinds)) as
    { path: string; sid: string; avail: number | null }[];
  const bySid = new Map<string, { avail: number | null; paths: string[] }>();
  for (const k of known) {
    const e = bySid.get(k.sid);
    if (e) e.paths.push(k.path); else bySid.set(k.sid, { avail: k.avail, paths: [k.path] });
  }
  const changes: [string, 0 | 1][] = [], check: [string, string[]][] = [];
  for (const [sid, s] of bySid) {
    const present = ids.has(sid) || s.paths.some((p) => listed.has(p));
    if (present && s.avail === 0) changes.push([sid, 1]);
    else if (!present && s.avail !== 0) check.push([sid, s.paths]);
  }
  for (let i = 0; i < check.length; i += STAT_CHUNK) {
    const part = check.slice(i, i + STAT_CHUNK);
    const gone = await Promise.all(part.map(async ([, paths]) => (await Promise.all(paths.map(enoent))).every(Boolean)));
    part.forEach(([sid], j) => { if (gone[j]) changes.push([sid, 0]); });
  }
  if (!changes.length) return;
  const flipped = o.writer.transact((db) => {
    const set = db.prepare('UPDATE sessions SET native_available = ? WHERE agent = ? AND profile_id = ? AND native_session_id = ? AND native_available IS NOT ?');
    return changes.filter(([sid, v]) => set.run(v, o.agent, o.profileId, sid, v).changes === 1).map(([sid]) => sid);
  });
  // re-review M1: like any committed batch, so open windows show the new state (no file, no events: nothing else runs)
  if (flipped.length) o.writer.notify({ profileId: o.profileId, agent: o.agent, sessions: flipped.map((nativeSessionId) => ({ nativeSessionId })), events: [] });
}

/** Effective Claude cleanupPeriodDays: managed policy (managed-settings.json, then managed-settings.d/*.json in order;
 *  the last that sets it) over user settings.json, else the default. null when any of those files is unreadable or the
 *  value is not a positive integer: no estimate rather than a wrong one. */
export function claudeCleanupDays(configDir: string, managedDir = CLAUDE_MANAGED_DIR): number | null {
  let dropIns: string[] = [];
  try { dropIns = readdirSync(path.join(managedDir, 'managed-settings.d')).filter((n) => n.endsWith('.json')).sort(); } catch (e) {
    if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return null;
  }
  const managed = [path.join(managedDir, 'managed-settings.json'), ...dropIns.map((n) => path.join(managedDir, 'managed-settings.d', n))].map(settings);
  const user = settings(path.join(configDir, 'settings.json'));
  if ([...managed, user].includes('bad')) return null;
  const set = (s: Record<string, unknown> | null | 'bad') => (s && s !== 'bad' && 'cleanupPeriodDays' in s ? s.cleanupPeriodDays : undefined);
  const v = managed.map(set).filter((x) => x !== undefined).at(-1) ?? set(user) ?? CLAUDE_CLEANUP_DEFAULT;
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** EC-23: when Claude's cleanup is estimated to delete this session's transcript; null for other agents, a deleted
 *  native session, no transcript checkpoint or no usable setting. */
export function nativeExpiresAt(db: DatabaseSync, s: { id: number; agent: string; profile_id: string; native_available: number | null }, managedDir?: string): number | null {
  if (s.agent !== 'claude' || s.native_available === 0) return null;
  const r = db.prepare(`SELECT p.root, (SELECT max(f.mtime) FROM source_files f WHERE f.session_id = ? AND f.kind = 'transcript' AND f.status <> 'gone') AS mtime
    FROM profiles p WHERE p.id = ?`).get(s.id, s.profile_id) as { root: string; mtime: number | null } | undefined;
  if (!r || r.mtime === null || !Number.isFinite(r.mtime)) return null;
  const days = claudeCleanupDays(r.root, managedDir);
  const at = days === null ? null : Math.floor(r.mtime) + days * DAY;
  return at !== null && at >= 0 && at <= MAX_DATE ? at : null; // review L3, re-review LOW-1: outside the Date range = no estimate
}
