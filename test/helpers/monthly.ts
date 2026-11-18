// XAIBO-PROD-512 (P5-T04): synthetic retained records for the monthly settlement tests (usage requests with estimates,
// turns, sessions, quota samples) and a purge stand-in that deletes a session's records, as permanent deletion will.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/service/store/db.ts';
import { settle } from '../../src/service/usage/settle.ts';

export const SECRET = Buffer.alloc(32, 7);

export async function monthlyStore(file = join(mkdtempSync(join(tmpdir(), 'xmonthly-')), 'xaibo.db')) {
  const { db } = await openStore({ file, backupDir: join(dirname(file), 'backups') });
  db.prepare("INSERT OR IGNORE INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  db.prepare("INSERT OR IGNORE INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', '/tmp/xaibo-fixture/codex', 'default')").run();
  for (const id of [1, 2]) {
    db.prepare("INSERT OR IGNORE INTO price_revisions (id, schema_version, source, revision, content_hash, body, accepted_at) VALUES (?, 1, 'bundled', ?, ?, '{}', 0)")
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

// XAIBO-PROD-513 (P5-T05, EC-103): a deterministic multi-month history and the expiry loop that settles and deletes it
// in batches, as the retention job (P5-T09) will.
const DAY = 24 * 3600_000, START = Date.UTC(2026, 9, 20, 12); // October 20 2026, 12:00 UTC
export function seedHistory(db: DatabaseSync) {
  for (let i = 0; i < 12; i++) {
    const t = START + i * 4 * DAY; // October to December
    const s = session(db, { profile: i % 3 === 2 ? 'p2' : 'p1', sid: `seed-${i}`, last: t + DAY });
    const model = i % 3 === 2 ? 'gpt-y' : i % 2 ? 'claude-x' : 'claude-z';
    turn(db, s, `seed-${i}-t1`, t, model);
    turn(db, s, `seed-${i}-t2`, t + DAY, model);
    request(db, s, { identity: `${i}:a`, ts: t, model, input: 10 + i, read: i, write: i % 4 ? 1 : null, output: 5 + i, cost: { usd: 0.01 * (i + 1), coverage: i % 4 ? 'full' : 'partial', rev: 1 + (i % 2) } });
    request(db, s, { identity: `${i}:b`, ts: t + DAY, model, output: 3, ...(i % 5 ? { cost: { usd: i % 7 ? 0.003 : null, coverage: i % 7 ? 'full' : 'none', rev: 1 } } : {}) });
  }
  db.prepare("INSERT OR IGNORE INTO usage_scopes (scope_key, profile_id, agent, epoch, verified) VALUES ('seed-scope', 'p2', 'codex', NULL, 1)").run();
  const sc = (db.prepare("SELECT id FROM usage_scopes WHERE scope_key = 'seed-scope'").get() as { id: number }).id;
  for (let i = 0; i < 10; i++) sample(db, sc, { percent: (i * 37) % 100, at: START + i * 5 * DAY, window: i % 2 ? 300 : 10080 });
}
/** One expiry batch: the oldest `size` sessions and quota rows are settled, then deleted, in one transaction (`hook` runs
 *  between the two). False when nothing is left. */
export function expireBatch(db: DatabaseSync, secret: Buffer, size: number, hook?: () => void): boolean {
  const ids = (db.prepare('SELECT id FROM sessions ORDER BY id LIMIT ?').all(size) as { id: number }[]).map((r) => r.id);
  const quota = (db.prepare('SELECT id FROM usage_history ORDER BY id LIMIT ?').all(size) as { id: number }[]).map((r) => r.id);
  if (!ids.length && !quota.length) return false;
  tx(db, () => {
    settle(db, { sessions: ids, quota }, secret, 1);
    hook?.();
    removeSessions(db, ids);
    for (const id of quota) db.prepare('DELETE FROM usage_history WHERE id = ?').run(id);
  });
  return true;
}
