// XAIBO-PROD-512 (P5-T04; FR-52): monthly usage totals. A contribution is one retained record's share of a month: a usage
// request (message-scope usage rows are per-request deltas; a Codex counter reset is a new identity, never negative), a
// turn, a session in a month, a session's use of a model in a month, or a quota reading. Each has an opaque key,
// HMAC-SHA256(per-install secret, labelled source identity) (Q-5.10, OQ-X14). The month is the local calendar month at the
// event time with its UTC offset. Cost comes only from per-request estimates (one month, one model); agent-reported
// session estimates are opaque and never prorated. The live view = frozen totals + retained contributions not yet settled.
import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { notDeleting } from '../history/suppression.ts';

export interface Bucket { month: string; offset: number }
/** The UTC offset (minutes) at `ts` in the process time zone. */
export const utcOffset = (ts: number) => -new Date(ts).getTimezoneOffset();
/** Local calendar month at `ts` and its UTC offset in minutes: with `offset` (XAIBO-PROD-542 G5b1-4: the one stored when
 *  the record was first observed) at that offset, else in the process time zone. */
export function monthOf(ts: number, offset?: number | null): Bucket {
  if (typeof offset === 'number') {
    const d = new Date(ts + offset * 60_000);
    return { month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, offset };
  }
  const d = new Date(ts);
  return { month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, offset: -d.getTimezoneOffset() };
}
/** XAIBO-PROD-542 G5b1-3: Clear usage history counts only rows stored up to these rowids (taken when the request came). */
export interface Watermarks { usage: number; turns: number; sessions: number; history: number }
const ALL_ROWS: Watermarks = { usage: Number.MAX_SAFE_INTEGER, turns: Number.MAX_SAFE_INTEGER, sessions: Number.MAX_SAFE_INTEGER, history: Number.MAX_SAFE_INTEGER };

export interface MonthUsage {
  month: string; agent: string; profileKey: string; modelId: string; sessions: number; turns: number; requests: number;
  uncachedInput: number; cacheRead: number; cacheWrite: number; output: number; tokenGaps: number;
  costUsd: number | null; costFull: number; costPartial: number; costNone: number; costPending: number; priceRevisions: number[];
}
export interface MonthSessions { month: string; agent: string; profileKey: string; sessions: number }
export interface MonthQuota { month: string; agent: string; scopeKey: string; limitId: string; windowMinutes: number | null; verified: boolean; peakPercent: number; observations: number }
export interface Monthly { usage: MonthUsage[]; sessions: MonthSessions[]; quota: MonthQuota[] }

type Coverage = 'full' | 'partial' | 'none' | 'pending';
interface Who { agent: string; profileKey: string }
export type Contribution = { key: string; at: Bucket } & (
  | ({ kind: 'u'; model: string; tokens: (number | null)[]; usd: number | null; coverage: Coverage; rev: number | null } & Who)
  | ({ kind: 't'; model: string } & Who)
  | ({ kind: 'm'; model: string; session: string } & Who) // session: its session-month key (P5-T16 review M2)
  | ({ kind: 's' } & Who)
  | { kind: 'q'; agent: string; scopeKey: string; limitId: string; window: number; verified: boolean; percent: number });

// Review L4: JSON keeps the parts apart (native ids may contain NUL). Regenerating the install secret orphans every
// settled key, so its file is created once and never replaced (log.ts loadInstallSecret).
const mac = (secret: Buffer, label: string, parts: (string | number)[]) =>
  createHmac('sha256', secret).update(JSON.stringify([label, ...parts])).digest('hex');
const keyOf = (secret: Buffer, kind: string, parts: (string | number)[]) => mac(secret, `xaibo-contribution/${kind}`, parts);
export const profileKey = (secret: Buffer, profileId: string) => mac(secret, 'xaibo-profile', [profileId]);
export const scopeKey = (secret: Buffer, key: string) => mac(secret, 'xaibo-usage-scope', [key]);

interface UsageRow {
  source: string; identity: string; model_id: string | null; uncached_input: number | null; cache_read: number | null; cache_write: number | null; output: number | null;
  ts: number | null; utc_offset: number | null; estimate: number | null; amount_usd: number | null; coverage: string | null; price_revision_id: number | null;
}
const COVERAGES: Coverage[] = ['full', 'partial', 'none'];
/** Review L5/L6: an estimate's coverage; malformed or missing JSON never throws (a deletion must not be blocked by it)
 *  and never contradicts the amount. No estimate row at all is 'pending'. */
function estimateOf(u: UsageRow): { coverage: Coverage; model: string | null } {
  if (u.estimate === null) return { coverage: 'pending', model: null };
  let est: { coverage?: unknown; model?: unknown } = {};
  try { const v = JSON.parse(u.coverage ?? '{}') as unknown; if (v && typeof v === 'object') est = v; } catch { /* treated as unknown coverage */ }
  const listed = COVERAGES.find((c) => c === est.coverage);
  const coverage = listed && (listed === 'none') === (u.amount_usd === null) ? listed : u.amount_usd === null ? 'none' : 'partial';
  return { coverage, model: typeof est.model === 'string' ? est.model : null };
}

/** The contributions of retained sessions: `ids`, or every session whose rows are not being deleted when null (its
 *  contributions were all settled before its purge's 'rows' phase; Gate 5 round 2: a session still settling counts, its
 *  settled keys skipped by the caller). `upTo`: only rows stored up to these rowids (Clear usage history). */
export function* sessionContributions(db: DatabaseSync, secret: Buffer, ids: number[] | null, upTo: Watermarks = ALL_ROWS): Generator<Contribution> {
  const one = db.prepare(`${SESSION_ROW} WHERE id = ?`);
  const rows = ids === null
    ? db.prepare(`${SESSION_ROW} s WHERE id <= ? AND ${notDeleting(db)} ORDER BY id`).iterate(upTo.sessions) as Iterable<SessionRow>
    : ids.map((id) => one.get(id) as SessionRow | undefined).filter((r): r is SessionRow => r !== undefined);
  const k = sessionKeys(db, secret);
  for (const s of rows) {
    const months: Months = new Map();
    yield* k.usage(s, months, 0, upTo.usage, -1);
    yield* k.turns(s, months, 0, upTo.turns, -1);
    yield* k.session(s, months);
  }
}

export const SESSION_ROW = 'SELECT id, agent, profile_id, native_session_id, last_activity, started_at FROM sessions';
export interface SessionRow { id: number; agent: string; profile_id: string; native_session_id: string; last_activity: number | null; started_at: number | null }
/** Per month a session has records in: the bucket of its earliest record, that record's time, the models seen. */
export type Months = Map<string, { at: Bucket; ts: number; models: Set<string> }>;
/** Rows read by the last usage/turns call and the last row id read (Gate 5 round 2: the purge's settlement cursor). */
export interface Read { rows: number; last: number }

/** One session's contributions in parts (prepared once): its requests and its turns with row ids in (after, upTo], at most
 *  `limit` rows (-1: all), each recording its month and model in `months`; then its session and per-model keys from
 *  every month seen. sessionContributions runs all three; the purge's settlement runs them in batches (purge.ts). */
export function sessionKeys(db: DatabaseSync, secret: Buffer) {
  const usage = db.prepare(`SELECT u.id, u.source, u.identity, u.model_id, u.uncached_input, u.cache_read, u.cache_write, u.output,
      coalesce(u.source_ts, ev.source_ts, ev.received_ts) AS ts, u.utc_offset, e.id AS estimate, e.amount_usd, e.coverage, e.price_revision_id
    FROM usage u LEFT JOIN events ev ON ev.id = u.event_id
    LEFT JOIN cost_estimates e ON e.session_id = u.session_id AND e.covered_scope = 'usage:' || u.source || ':' || u.identity
    WHERE u.session_id = ? AND u.scope = 'message' AND u.id > ? AND u.id <= ? ORDER BY u.id LIMIT ?`);
  const turns = db.prepare(`SELECT id, native_turn_id, coalesce(started_at, ended_at) AS ts, model_id, utc_offset FROM turns
    WHERE session_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?`);
  const settledAt = db.prepare('SELECT month, utc_offset FROM settled_contributions WHERE key = ?');
  // Review M1: a settled record keeps the month it was settled in, so a later time-zone change cannot move it (or its
  // session-month keys) into another month and count it twice; an unsettled one takes its stored offset (G5b1-4).
  const bucket = (key: string, ts: number, offset: number | null = null): Bucket => {
    const r = settledAt.get(key) as { month: string; utc_offset: number } | undefined;
    return r ? { month: r.month, offset: r.utc_offset } : monthOf(ts, offset);
  };
  const parts = (s: SessionRow) => ({ who: { agent: s.agent, profileKey: profileKey(secret, s.profile_id) } as Who, id: [s.agent, s.profile_id, s.native_session_id],
    fallback: s.last_activity ?? s.started_at }); // review M2: a record without its own time takes the session's
  const seen = (months: Months, at: Bucket, ts: number, model: string) => {
    const m = months.get(at.month);
    if (!m) months.set(at.month, { at, ts, models: new Set([model]) });
    else { m.models.add(model); if (ts < m.ts) { m.ts = ts; m.at = at; } } // the bucket's offset: its earliest event
  };
  return {
    *usage(s: SessionRow, months: Months, after: number, upTo: number, limit: number, read: Read = { rows: 0, last: after }): Generator<Contribution> {
      const { who, id, fallback } = parts(s);
      for (const u of usage.iterate(s.id, after, upTo, limit) as Iterable<UsageRow & { id: number }>) {
        read.rows++; read.last = u.id;
        const ts = u.ts ?? fallback;
        if (ts === null) continue; // neither the record nor its session has any time: no month to count it in
        const est = estimateOf(u);
        const model = est.model ?? u.model_id ?? '';
        const key = keyOf(secret, 'u', [...id, u.source, u.identity]), at = bucket(key, ts, u.utc_offset);
        seen(months, at, ts, model);
        yield { kind: 'u', key, at, ...who, model, tokens: [u.uncached_input, u.cache_read, u.cache_write, u.output], usd: u.amount_usd, coverage: est.coverage,
          rev: u.amount_usd === null ? null : u.price_revision_id };
      }
    },
    *turns(s: SessionRow, months: Months, after: number, upTo: number, limit: number, read: Read = { rows: 0, last: after }): Generator<Contribution> {
      const { who, id, fallback } = parts(s);
      for (const t of turns.iterate(s.id, after, upTo, limit) as Iterable<{ id: number; native_turn_id: string; ts: number | null; model_id: string | null; utc_offset: number | null }>) {
        read.rows++; read.last = t.id;
        const ts = t.ts ?? fallback;
        if (ts === null) continue;
        const key = keyOf(secret, 't', [...id, t.native_turn_id]), at = bucket(key, ts, t.utc_offset);
        seen(months, at, ts, t.model_id ?? '');
        yield { kind: 't', key, at, ...who, model: t.model_id ?? '' };
      }
    },
    *session(s: SessionRow, months: Months): Generator<Contribution> {
      const { who, id, fallback } = parts(s);
      // a session with no turn or request: a month-free key, so a settled one keeps its month across a time-zone change
      const s0 = keyOf(secret, 's0', id);
      if (months.size === 0) {
        if (fallback === null) return;
        const at = bucket(s0, fallback);
        yield { kind: 's', key: s0, at, ...who };
        yield { kind: 'm', key: keyOf(secret, 'm', [...id, at.month, '']), at, ...who, model: '', session: s0 };
        return;
      }
      // XAIBO-PROD-542 G5b1-2: an s0 key settled or cleared while the session had no record stays that month's session key
      // (its first turn later in the same month neither counts the session again nor brings a cleared one back)
      const s0At = settledAt.get(s0) as { month: string } | undefined;
      for (const [month, m] of months) {
        const sessionKey = s0At?.month === month ? s0 : keyOf(secret, 's', [...id, month]);
        yield { kind: 's', key: sessionKey, at: m.at, ...who };
        // review L3: "model unavailable" only when the month has no known model.
        // ponytail: the model is part of the key, so a kept settled session whose model id later resolves (alias, '' to a
        // name) adds one per-model session count; tokens and cost are unaffected. Read models from settled keys if it matters.
        const models = m.models.size > 1 ? [...m.models].filter((x) => x !== '') : [...m.models];
        for (const model of models) yield { kind: 'm', key: keyOf(secret, 'm', [...id, month, model]), at: m.at, ...who, model, session: sessionKey };
      }
    },
  };
}

/** Quota readings with a measured percent: usage_history rows `ids`, or all (up to rowid `upTo`) when null. */
export function* quotaContributions(db: DatabaseSync, secret: Buffer, ids: number[] | null, upTo = Number.MAX_SAFE_INTEGER): Generator<Contribution> {
  const sql = `SELECT h.limit_id, h.used_percent, h.window_minutes, h.measured_at, h.utc_offset, sc.scope_key, sc.verified, sc.agent
    FROM usage_history h JOIN usage_scopes sc ON sc.id = h.usage_scope_id WHERE h.used_percent IS NOT NULL`;
  type Q = { limit_id: string; used_percent: number; window_minutes: number | null; measured_at: number; utc_offset: number | null; scope_key: string; verified: number; agent: string };
  const one = db.prepare(`${sql} AND h.id = ?`);
  const rows = ids === null ? db.prepare(`${sql} AND h.id <= ?`).iterate(upTo) as Iterable<Q> : ids.map((id) => one.get(id) as Q | undefined).filter((r): r is Q => r !== undefined);
  for (const q of rows) {
    const window = q.window_minutes ?? -1;
    // XAIBO-PROD-542 G5b1-1: no `kind` in the key; a backfilled older reading can reclassify a sample as a transition
    yield { kind: 'q', key: keyOf(secret, 'q', [q.scope_key, q.limit_id, window, q.measured_at]), at: monthOf(q.measured_at, q.utc_offset), agent: q.agent,
      scopeKey: scopeKey(secret, q.scope_key), limitId: q.limit_id, window, verified: q.verified === 1, percent: q.used_percent };
  }
}

/** Review L9: totals keep cost in integer micro-USD so sums are exact in any batch order; costUsd is derived on output. */
type Acc = Omit<MonthUsage, 'costUsd'> & { costMicros: number | null };
const zero = (month: string, w: Who, modelId: string): Acc => ({ month, ...w, modelId, sessions: 0, turns: 0, requests: 0, uncachedInput: 0, cacheRead: 0,
  cacheWrite: 0, output: 0, tokenGaps: 0, costMicros: null, costFull: 0, costPartial: 0, costNone: 0, costPending: 0, priceRevisions: [] });
const addCost = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);

/** Running monthly totals; `add` folds a contribution or a frozen row in. */
export class Totals {
  readonly usage = new Map<string, Acc>();
  readonly sessions = new Map<string, MonthSessions>();
  readonly quota = new Map<string, MonthQuota>();
  private row(month: string, w: Who, model: string) {
    const k = [month, w.agent, w.profileKey, model].join('\0');
    let r = this.usage.get(k);
    if (!r) this.usage.set(k, r = zero(month, { agent: w.agent, profileKey: w.profileKey }, model));
    return r;
  }
  add(c: Contribution) {
    const month = c.at.month;
    if (c.kind === 'q') return this.addQuota({ month, agent: c.agent, scopeKey: c.scopeKey, limitId: c.limitId, windowMinutes: c.window < 0 ? null : c.window, verified: c.verified, peakPercent: c.percent, observations: 1 });
    if (c.kind === 's') return this.addSessions({ month, agent: c.agent, profileKey: c.profileKey, sessions: 1 });
    const d = zero(month, c, c.model);
    if (c.kind === 't') d.turns = 1;
    else if (c.kind === 'm') d.sessions = 1;
    else {
      const [i, r, w, o] = c.tokens;
      Object.assign(d, { requests: 1, uncachedInput: i ?? 0, cacheRead: r ?? 0, cacheWrite: w ?? 0, output: o ?? 0, tokenGaps: c.tokens.includes(null) ? 1 : 0, costMicros: c.usd === null ? null : Math.round(c.usd * 1e6),
        costFull: +(c.coverage === 'full'), costPartial: +(c.coverage === 'partial'), costNone: +(c.coverage === 'none'), costPending: +(c.coverage === 'pending'),
        priceRevisions: c.rev === null ? [] : [c.rev] });
    }
    this.addUsage(d);
  }
  addUsage(d: Acc) {
    const r = this.row(d.month, d, d.modelId);
    for (const k of ['sessions', 'turns', 'requests', 'uncachedInput', 'cacheRead', 'cacheWrite', 'output', 'tokenGaps', 'costFull', 'costPartial', 'costNone', 'costPending'] as const) r[k] += d[k];
    r.costMicros = addCost(r.costMicros, d.costMicros);
    r.priceRevisions = [...new Set([...r.priceRevisions, ...d.priceRevisions])].sort((a, b) => a - b);
  }
  addSessions(d: MonthSessions) {
    const k = [d.month, d.agent, d.profileKey].join('\0');
    const r = this.sessions.get(k);
    if (r) r.sessions += d.sessions; else this.sessions.set(k, { ...d });
  }
  addQuota(d: MonthQuota) {
    const k = [d.month, d.scopeKey, d.limitId, d.windowMinutes ?? -1].join('\0');
    const r = this.quota.get(k);
    // review L7: a scope that became verified stays verified
    if (r) { r.peakPercent = Math.max(r.peakPercent, d.peakPercent); r.observations += d.observations; r.verified ||= d.verified; } else this.quota.set(k, { ...d });
  }
  result(): Monthly {
    const by = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
    return { usage: by(this.usage).map(({ costMicros, ...r }) => ({ ...r, costUsd: costMicros === null ? null : costMicros / 1e6 })), sessions: by(this.sessions), quota: by(this.quota) };
  }
}

/** The frozen totals as stored. */
export function frozen(db: DatabaseSync): Totals {
  const t = new Totals();
  for (const r of db.prepare('SELECT * FROM monthly_usage').iterate() as Iterable<Record<string, number | string | null>>) {
    t.addUsage({ month: String(r.month), agent: String(r.agent), profileKey: String(r.profile_key), modelId: String(r.model_id), sessions: Number(r.sessions),
      turns: Number(r.turns), requests: Number(r.requests), uncachedInput: Number(r.uncached_input), cacheRead: Number(r.cache_read), cacheWrite: Number(r.cache_write),
      output: Number(r.output), tokenGaps: Number(r.token_gaps), costMicros: r.cost_micros === null ? null : Number(r.cost_micros), costFull: Number(r.cost_full),
      costPartial: Number(r.cost_partial), costNone: Number(r.cost_none), costPending: Number(r.cost_pending), priceRevisions: JSON.parse(String(r.price_revisions)) as number[] });
  }
  for (const r of db.prepare('SELECT month, agent, profile_key, sessions FROM monthly_sessions').iterate() as Iterable<{ month: string; agent: string; profile_key: string; sessions: number }>) {
    t.addSessions({ month: r.month, agent: r.agent, profileKey: r.profile_key, sessions: r.sessions });
  }
  for (const r of db.prepare('SELECT * FROM monthly_quota_peaks').iterate() as Iterable<{ month: string; agent: string; scope_key: string; limit_id: string; window_minutes: number; verified: number; peak_percent: number; observations: number }>) {
    t.addQuota({ month: r.month, agent: r.agent, scopeKey: r.scope_key, limitId: r.limit_id, windowMinutes: r.window_minutes < 0 ? null : r.window_minutes,
      verified: r.verified === 1, peakPercent: r.peak_percent, observations: r.observations });
  }
  return t;
}

/** Month totals = frozen totals + every retained contribution whose key is not settled (FR-52). */
export function liveMonthly(db: DatabaseSync, secret: Buffer): Monthly {
  const t = frozen(db);
  const settled = db.prepare('SELECT 1 FROM settled_contributions WHERE key = ?');
  const cleared = clearedSession(db);
  for (const gen of [sessionContributions(db, secret, null), quotaContributions(db, secret, null)]) {
    for (const c of gen) if (!settled.get(c.key) && !cleared(c)) t.add(c);
  }
  return t.result();
}

/** XAIBO-PROD-525 review M2: a session's per-model count in a month whose session count was cleared (Clear usage
 *  history) stays cleared, even when a model resolves only afterwards (a new per-model key). */
export function clearedSession(db: DatabaseSync): (c: Contribution) => boolean {
  const q = db.prepare('SELECT 1 FROM settled_contributions WHERE key = ? AND cleared = 1');
  return (c) => c.kind === 'm' && q.get(c.session) !== undefined;
}

/** XAIBO-PROD-514 (P5-T06; US-20): the agent filter applies to usage, sessions and quota; the model filter to usage and
 *  sessions only (quota peaks are not attributed to models). With a model, sessions are those that used that model. */
export function filterMonthly(m: Monthly, f: { agent: string | null; model: string | null }): Monthly {
  const agent = <T extends { agent: string }>(r: T) => f.agent === null || r.agent === f.agent;
  const usage = m.usage.filter((u) => agent(u) && (f.model === null || u.modelId === f.model));
  if (f.model === null) return { usage, sessions: m.sessions.filter(agent), quota: m.quota.filter(agent) };
  const t = new Totals();
  for (const u of usage) if (u.sessions) t.addSessions({ month: u.month, agent: u.agent, profileKey: u.profileKey, sessions: u.sessions });
  return { usage, sessions: t.result().sessions, quota: m.quota.filter(agent) };
}
