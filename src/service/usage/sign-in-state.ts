// XAIBO-PROD-571 (P6-T01a slice 2; S-38, FR-54, EC-109; design .handoff/p6-t01a-design.md "State transitions and epoch
// rules", security review 3636): per-profile sign-in state. The owner's declaration wins (explicit Unknown too); output
// evidence counts only with a trusted source time; a new usage epoch (generation) starts only on an effective method
// change or a declared account change, never on absence, at most MAX_BOUNDARIES times per profile. Times are assigned by
// the service; callers give only the input and the revision they saw. Reads no credential, auth, config or environment.
import type { DatabaseSync } from 'node:sqlite';
import type { KnownMethod, Method, MethodResult, SignalSource } from './sign-in.ts';

export const MAX_BOUNDARIES = 256;
const SKEW_MS = 5 * 60_000; // as snapshots.sourceTime: a source time this far after its observation is not trusted
const FLOOR = Date.UTC(2020, 0, 1); // review H1: older than any supported agent output
// ponytail: a stored boundary more than a day ahead of the clock came from a wrong clock, so it no longer holds later
// boundaries back; ordinary steps (sleep, time zone, NTP) stay monotonic. A config knob if a day is ever wrong.
const FAR_AHEAD_MS = 86_400_000;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[A-Za-z0-9.-]{1,48})?$/;
const RULE_ID = /^[a-z]+(?:-[a-z]+)*$/;

export interface Evidence {
  method: KnownMethod; source: SignalSource; version: string; ruleId: string;
  /** observedAt: when the service first stored this method; sourceAt: its source time; orderAt: the newest source time
   *  seen for it (the replay watermark, never shown as freshness). */
  observedAt: number; sourceAt: number; orderAt: number;
  /** review M1: an equal-time disagreement; ambiguous evidence gives no method. */
  ambiguous: boolean;
}
export interface SignInState {
  revision: number; generation: number;
  /** The method the last epoch decision used; absence never resets it. */
  boundaryMethod: Method; boundaryAt: number | null;
  declaration: { method: Method; at: number } | null;
  evidence: Evidence | null;
}
export type SignInInput =
  | { kind: 'evidence'; result: MethodResult; source: SignalSource; version: string | null; sourceAt: number | null }
  | { kind: 'declare'; method: Method }
  | { kind: 'clear' }
  | { kind: 'account-change' };
export interface Boundary { generation: number; at: number; reason: 'method' | 'declared-account'; method: Method }

export const emptySignIn = (): SignInState => ({ revision: 0, generation: 0, boundaryMethod: 'unknown', boundaryAt: null, declaration: null, evidence: null });
const evidenced = (s: SignInState) => (s.evidence && !s.evidence.ambiguous ? s.evidence.method : null);
export const effectiveMethod = (s: SignInState): Method => s.declaration?.method ?? evidenced(s) ?? 'unknown';
/** The effective method comes from a declaration or evidence, not from absence. */
const explicit = (s: SignInState) => s.declaration !== null || evidenced(s) !== null;

function withEvidence(s: SignInState, i: Extract<SignInInput, { kind: 'evidence' }>, now: number): SignInState {
  const t = i.sourceAt;
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < FLOOR || t > now + SKEW_MS) return s; // review H1
  const e = s.evidence;
  if (i.result.kind === 'unknown') {
    return i.result.reason === 'ambiguous' && e && t > e.orderAt ? { ...s, evidence: { ...e, ambiguous: true, orderAt: t } } : s;
  }
  const { method, ruleId } = i.result;
  if (typeof i.version !== 'string' || !VERSION.test(i.version) || ruleId.length > 64 || !RULE_ID.test(ruleId)) return s; // review M2
  if (e && t < e.orderAt) return s; // older never replaces newer (replay)
  if (e && t === e.orderAt) return e.method === method || e.ambiguous ? s : { ...s, evidence: { ...e, ambiguous: true } };
  if (e && e.method === method && !e.ambiguous) return { ...s, evidence: { ...e, orderAt: t } };
  return { ...s, evidence: { method, source: i.source, version: i.version, ruleId, observedAt: now, sourceAt: t, orderAt: t, ambiguous: false } };
}

/** Everything but the replay watermark: a watermark-only change is stored without a new revision. */
const visible = (s: SignInState) => JSON.stringify({ ...s, evidence: s.evidence && { ...s.evidence, orderAt: 0 } });

/** The next state, and the epoch boundary it starts if any; the same object back when nothing changes. */
export function nextSignIn(s: SignInState, i: SignInInput, now: number): { state: SignInState; boundary: Boundary | null } | { refused: 'limit' } {
  const n = i.kind === 'evidence' ? withEvidence(s, i, now)
    : i.kind === 'declare' ? (s.declaration?.method === i.method ? s : { ...s, declaration: { method: i.method, at: now } })
      : i.kind === 'clear' ? (s.declaration ? { ...s, declaration: null } : s)
        : s;
  const method = effectiveMethod(n);
  const reason = i.kind === 'account-change' ? 'declared-account' : explicit(n) && method !== s.boundaryMethod ? 'method' : null;
  if (!reason) return { state: n === s ? s : visible(n) === visible(s) ? n : { ...n, revision: s.revision + 1 }, boundary: null };
  if (s.generation >= MAX_BOUNDARIES) return i.kind === 'evidence' ? { state: s, boundary: null } : { refused: 'limit' }; // review H2
  // review H1: never before the previous boundary, unless that one was stored while the clock ran far ahead (code review
  // M1: one wrong clock reading must not pin every later boundary). An evidence epoch starts at acceptance (now), not at
  // its source time: readings dated between the two stay in the old epoch (code review L5).
  const prev = s.boundaryAt !== null && s.boundaryAt <= now + FAR_AHEAD_MS ? s.boundaryAt : now;
  const at = Math.max(prev, now);
  const boundary: Boundary = { generation: s.generation + 1, at, reason, method };
  return { state: { ...n, revision: s.revision + 1, generation: boundary.generation, boundaryAt: at, boundaryMethod: explicit(n) ? method : s.boundaryMethod }, boundary };
}

type Row = { revision: number; generation: number; boundary_method: Method; boundary_at: number | null; declared_method: Method | null; declared_at: number | null;
  output_method: KnownMethod | null; output_source: SignalSource | null; output_version: string | null; output_rule_id: string | null;
  output_observed_at: number | null; output_source_at: number | null; output_order_at: number | null; output_ambiguous: number | null };

/** The profile's state; Unknown with nothing invented when it has no row, or before migration 027 (review L2). */
export function readSignIn(db: DatabaseSync, profileId: string): SignInState {
  let r: Row | undefined;
  try { r = db.prepare('SELECT * FROM profile_sign_in WHERE profile_id = ?').get(profileId) as Row | undefined; } catch (e) {
    if (/no such table/.test(String((e as Error).message))) return emptySignIn();
    throw e; // code review M2: a busy or failing store is never read as "no state" (that would pass a revision-0 check)
  }
  if (!r) return emptySignIn();
  return {
    revision: r.revision, generation: r.generation, boundaryMethod: r.boundary_method, boundaryAt: r.boundary_at,
    declaration: r.declared_method === null ? null : { method: r.declared_method, at: r.declared_at! },
    evidence: r.output_method === null ? null : { method: r.output_method, source: r.output_source!, version: r.output_version!, ruleId: r.output_rule_id!,
      observedAt: r.output_observed_at!, sourceAt: r.output_source_at!, orderAt: r.output_order_at!, ambiguous: r.output_ambiguous === 1 },
  };
}

export type SignInCode = 'ok' | 'stale' | 'profile-not-found' | 'limit';

/** Applies one input for a profile. Call inside one immediate transaction (Writer.transact, or the batch commit), so the
 *  revision read here is the one written (review M3). `expectedRevision`: owner actions; a mismatch changes nothing. */
export function changeSignIn(db: DatabaseSync, profileId: string, input: SignInInput, now: number, expectedRevision?: number): { code: SignInCode; state: SignInState } {
  const s = readSignIn(db, profileId);
  if (expectedRevision !== undefined && expectedRevision !== s.revision) return { code: 'stale', state: s };
  if (!db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId)) return { code: 'profile-not-found', state: s };
  const r = nextSignIn(s, input, now);
  if ('refused' in r) return { code: 'limit', state: s };
  if (r.state === s) return { code: 'ok', state: s };
  const n = r.state, e = n.evidence;
  db.prepare(`INSERT INTO profile_sign_in (profile_id, revision, generation, boundary_method, boundary_at, declared_method, declared_at, output_method,
      output_source, output_version, output_rule_id, output_observed_at, output_source_at, output_order_at, output_ambiguous)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (profile_id) DO UPDATE SET revision = excluded.revision, generation = excluded.generation, boundary_method = excluded.boundary_method,
      boundary_at = excluded.boundary_at, declared_method = excluded.declared_method, declared_at = excluded.declared_at, output_method = excluded.output_method,
      output_source = excluded.output_source, output_version = excluded.output_version, output_rule_id = excluded.output_rule_id,
      output_observed_at = excluded.output_observed_at, output_source_at = excluded.output_source_at, output_order_at = excluded.output_order_at,
      output_ambiguous = excluded.output_ambiguous`).run(profileId, n.revision, n.generation, n.boundaryMethod, n.boundaryAt, n.declaration?.method ?? null,
    n.declaration?.at ?? null, e?.method ?? null, e?.source ?? null, e?.version ?? null, e?.ruleId ?? null, e?.observedAt ?? null, e?.sourceAt ?? null,
    e?.orderAt ?? null, e ? (e.ambiguous ? 1 : 0) : null);
  if (r.boundary) {
    db.prepare('INSERT INTO sign_in_boundaries (profile_id, generation, revision, at, reason, method) VALUES (?, ?, ?, ?, ?, ?)')
      .run(profileId, r.boundary.generation, n.revision, r.boundary.at, r.boundary.reason, r.boundary.method);
  }
  return { code: 'ok', state: n };
}
