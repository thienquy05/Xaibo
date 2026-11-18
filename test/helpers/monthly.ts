// XAIBO-PROD-512 (P5-T04): synthetic retained records for the monthly settlement tests (usage requests with estimates,
// turns, sessions, quota samples) and a purge stand-in that deletes a session's records, as permanent deletion will.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/service/store/db.ts';

export const SECRET = Buffer.alloc(32, 7);

export async function monthlyStore() {
  const dir = mkdtempSync(join(tmpdir(), 'xmonthly-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', '/tmp/xaibo-fixture/codex', 'default')").run();
  for (const id of [1, 2]) {
    db.prepare("INSERT INTO price_revisions (id, schema_version, source, revision, content_hash, body, accepted_at) VALUES (?, 1, 'bundled', ?, ?, '{}', 0)")
      .run(id, `r${id}`, `h${id}`);
  }
  return db;
}

export function session(db: DatabaseSync, o: { profile?: string; sid: string; cwd?: string; title?: string; last?: number | null; started?: number | null }) {
  const p = o.profile ?? 'p1';
  return Number(db.prepare('INSERT INTO sessions (agent, profile_id, native_session_id, cwd, title, started_at, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p === 'p2' ? 'codex' : 'claude', p, o.sid, o.cwd ?? null, o.title ?? null, o.started ?? null, o.last ?? null).lastInsertRowid);
}

export interface Req {
  identity: string; ts: number | null; model?: string | null; input?: number | null; read?: number | null; write?: number | null; output?: number | null;
  /** the request's estimate: amount (null = unavailable), coverage, price revision; omitted = not priced yet */
  cost?: { usd: number | null; coverage: 'full' | 'partial' | 'none'; rev: number | null; model?: string | null };
}
export function request(db: DatabaseSync, sessionId: number, r: Req) {
  db.prepare(`INSERT INTO usage (session_id, schema_version, source, identity, scope, model_id, uncached_input, cache_read, cache_write, output, source_ts)
    VALUES (?, 1, 'transcript', ?, 'message', ?, ?, ?, ?, ?, ?)`)
    .run(sessionId, r.identity, r.model ?? null, ...[r.input, r.read, r.write, r.output].map((v) => (v === undefined ? 0 : v)), r.ts); // null = missing
  if (r.cost) {
    db.prepare(`INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd, basis, coverage, price_revision_id, as_of)
      VALUES (?, 1, 'transcript', ?, ?, 'token_table', ?, ?, ?)`)
      .run(sessionId, `usage:transcript:${r.identity}`, r.cost.usd, JSON.stringify({ coverage: r.cost.coverage, gaps: [], model: r.cost.model ?? r.model ?? null, child: false }), r.cost.rev, r.ts);
  }
}
/** An agent-reported session estimate (opaque: never attributed to a month or model). */
export function reportedCost(db: DatabaseSync, sessionId: number, usd: number) {
  db.prepare("INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd, basis, coverage) VALUES (?, 1, 'statusline', 'session', ?, 'agent_reported', '{}')")
    .run(sessionId, usd);
}
export function turn(db: DatabaseSync, sessionId: number, nativeTurnId: string, started: number | null, model: string | null = null) {
  db.prepare("INSERT INTO turns (session_id, schema_version, source, native_turn_id, started_at, model_id) VALUES (?, 1, 'transcript', ?, ?, ?)")
    .run(sessionId, nativeTurnId, started, model);
}
export function scope(db: DatabaseSync, key: string, verified: boolean, profile = 'p2') {
  return Number(db.prepare("INSERT INTO usage_scopes (scope_key, profile_id, agent, epoch, verified) VALUES (?, ?, 'codex', NULL, ?)")
    .run(key, profile, verified ? 1 : 0).lastInsertRowid);
}
export function sample(db: DatabaseSync, scopeId: number, o: { limit?: string; window?: number | null; percent: number | null; at: number; kind?: 'sample' | 'transition'; locator?: string }) {
  return Number(db.prepare(`INSERT INTO usage_history (schema_version, usage_scope_id, limit_id, kind, minute, used_percent, window_minutes, first_observed_at, observed_at, measured_at, source, source_locator)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rollout', ?)`)
    .run(scopeId, o.limit ?? 'codex', o.kind ?? 'sample', Math.floor(o.at / 60_000), o.percent, o.window === undefined ? 300 : o.window, o.at, o.at, o.at, o.locator ?? 'x').lastInsertRowid);
}
/** Stand-in for permanent deletion (P5-T07): the session's records go; the caller settles first in the same transaction. */
export function removeSessions(db: DatabaseSync, ids: number[]) {
  for (const id of ids) for (const t of ['cost_estimates', 'usage', 'turns']) db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id);
  for (const id of ids) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
export const tx = <T>(db: DatabaseSync, f: () => T): T => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};
export const dump = (db: DatabaseSync) => JSON.stringify(['monthly_usage', 'monthly_sessions', 'monthly_quota_peaks', 'settled_contributions']
  .map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
