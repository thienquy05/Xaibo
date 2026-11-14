// Status engine (P3-T08; PRD §5.5, §6.1-§6.3; FR-04, FR-05; EC-02, EC-40, EC-41, EC-70; D-P3-07). Turns hook, report and
// native-file observations into per-session lifecycle, confidence, health and reason. Each observation is mapped by its
// agent's status map to normalized evidence (no content), persisted for restart, and kept per session sorted by
// (receive time, source rank, source order). Status is a pure function of that ordered evidence and the clock: the fold
// gives the turn state, the read applies the turn settle and the no-hook heuristic. So a delayed, duplicated or replayed
// delivery lands in its causal place and the result does not depend on arrival order. Precedence: hooks/report outrank
// native-file inference (a file record only drives lifecycle until the session's first hook), except the Claude
// transcript rejection, which no hook reports (S7). OTel never drives status. Silence never ends a session.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Envelope } from '../../shared/hook-protocol.ts';
import { agyFileEvidence } from '../adapters/agy/status-map.ts';
import { claudeEvidence } from '../adapters/claude/status-map.ts';
import { codexEvidence } from '../adapters/codex/status-map.ts';
import { hookMapper } from '../adapters/generic/mapping.ts';
import { reportEvidence } from '../adapters/generic/report.ts';
import { loadCatalog, type Catalog } from '../catalog/validate.ts';
import { awake, freshPatterns, onCall, RULE_DEFAULTS, type Patterns, type RuleSettings } from './rules.ts';

export type Lifecycle = 'idle' | 'busy' | 'waiting-for-permission' | 'needs-input' | 'error' | 'ended' | 'unknown';
export type Confidence = 'confirmed' | 'inferred' | 'heuristic';
export type Health = 'connected' | 'stale' | 'detached';

export interface SessionStatus {
  lifecycle: Lifecycle; confidence: Confidence; health: Health;
  /** 'Finishing…', 'Background work', 'Probably waiting', or null. */
  reason: string | null;
  /** P3-T16e: while Finishing… with no subagent running, when it settles (stop time + settle interval, ms); else null. */
  settleAt: number | null;
  /** Outcome of the last turn or request: 'interrupted', 'denied', 'declined', 'cancelled', or null. */
  outcome: string | null;
  /** Active §6.4 finding rule ids ('R1'–'R5'), sorted (P3-T09). */
  findings: string[];
  toolCalls: number; turns: number;
  usage: Record<string, number> | null;
  model: string | null; effort: string | null;
}

export type Observation =
  | { source: 'hook' | 'report'; envelope: Envelope }
  /** profile: the profile id of the batch the line came from (§5.5 identity is agent, profile, native session id). */
  | { source: 'file'; agent: string; profile: string; sessionId: string; file: string; offset: number; line: string; receivedTs: number }
  | { source: 'otel'; agent: string; sessionId: string; record: unknown; receivedTs: number };

export interface StatusEngine {
  ingest(o: Observation): void;
  /** The clock moved; status is read against `now()`, so nothing is scheduled here. */
  advance(now: number): void;
  suspend(now: number): void;
  resume(now: number): void;
  status(agent: string, profile: string, sessionId: string): SessionStatus | null;
  close(): void;
}
export type WaitState = 'waiting-for-permission' | 'needs-input';
export interface EngineOptions {
  db: DatabaseSync; now: () => number; settleMs: number; log: (line: string) => void;
  /** §6.4 thresholds; missing keys take RULE_DEFAULTS. */
  rules?: Partial<RuleSettings>;
  /** P3-T11 notify intent (Q3-11): a confirmed request newly pending after the ingest of the entry that carries it,
   *  received within the last 60 s. Requests are confirmed-only evidence, so a heuristic wait never calls it; evidence
   *  reloaded at start never calls it. A request that changes kind under the same id is not new (review LOW-2). */
  onWait?: (agent: string, profile: string, sessionId: string, state: WaitState) => void;
  /** Agent catalog for hook mappings (P3-T13a); the bundled catalog by default. */
  catalog?: Catalog;
}

/** Normalized evidence, the output of an agent's status map. Ids are native ids; nothing here is content. */
export type Ev =
  | { k: 'session.start' } | { k: 'session.end' }
  | { k: 'turn.start'; typed: boolean; turn?: string }
  /** reopen: work started again even after a stop or idle (agy PreInvocation, P3-T13a); never counts a turn. */
  | { k: 'activity'; reopen?: true }
  /** Reported model id and effort (FR-51), kept as reported; the latest of each wins. */
  | { k: 'model'; id?: string; effort?: string }
  /** sig: tool and normalized args; on tool.end, the result (or error, with err). Hashes for R2–R4, never content. */
  | { k: 'tool.start'; id: string; tool?: string; background?: true; child?: true; sig?: string }
  | { k: 'tool.end'; id: string; sig?: string; err?: true }
  /** Claude transcript rejection of a call: a manual denial if it had a PermissionRequest, else an interrupt (S7). */
  | { k: 'tool.rejected'; id: string }
  /** id null: join to the session's latest started call (Claude PermissionRequest has no tool_use_id). */
  | { k: 'request'; kind: 'permission' | 'input'; id: string | null }
  | { k: 'resolve'; id: string; outcome: string | null }
  /** turn.end shows Finishing… and settles; turn.idle is an immediate idle (Claude end-of-turn record without hooks). */
  | { k: 'turn.end' } | { k: 'turn.idle' } | { k: 'turn.error' } | { k: 'interrupt' }
  | { k: 'child.start'; id: string } | { k: 'child.end'; id: string }
  /** Usage under a key (message id, or 'total' for a cumulative counter); the latest per key wins, keys are summed. */
  | { k: 'usage'; key: string; usage: Record<string, number> };

/** null = no mapping matched: reduced coverage, nothing stored (P3-T13a). */
type StatusMap = (o: Observation) => Ev[] | null;
const FILE_MAPS: Record<string, (line: string) => Ev[]> = { agy: agyFileEvidence };
// A Map, so an agent name such as `constructor` can never reach Object.prototype (security review). Claude and Codex are
// hand-written (§6.2/§6.3); other agents map hooks through their catalog rules (§6.8) and files through FILE_MAPS.
function statusMaps(catalog: Catalog): Map<string, StatusMap> {
  const maps = new Map<string, StatusMap>([['claude', claudeEvidence], ['codex', codexEvidence]]);
  for (const a of catalog.agents) {
    if (maps.has(a.id) || !a.hookMappings) continue;
    const hook = hookMapper(a.hookMappings), file = Object.hasOwn(FILE_MAPS, a.id) ? FILE_MAPS[a.id]! : null;
    maps.set(a.id, (o) => (o.source === 'file' ? (file ? file(o.line) : []) : o.source === 'otel' ? [] : hook(o.envelope)));
  }
  return maps;
}
const HEURISTIC_MS = 5000;
/** P3-T11: older requests do not notify; above the service's 30 s restart backoff cap (D-P3-10). */
const NOTIFY_MAX_AGE_MS = 60_000;
/** Evidence kept per observation: bounds what one adversarial line or payload can add. */
const MAX_EVS = 256;
/** Evidence a file record may never produce: only a hook or report confirms these (§6.1-§6.3). */
const TURN_ENDS = new Set<Ev['k']>(['turn.end', 'turn.idle', 'turn.error', 'interrupt', 'session.end']);
const CONFIRMED_ONLY = new Set<Ev['k']>(['session.start', 'session.end', 'request', 'resolve', 'turn.error', 'interrupt']);

/** pid/pseq: a report's producer_id and producer_seq; the last sort key, so a late report placed at its successor's
 *  (ts, rank, seq) sorts before it (G3c-3). */
interface Entry { ts: number; rank: number; seq: number; conf: 'confirmed' | 'inferred'; evs: Ev[]; pid?: string; pseq?: number }
interface Fold {
  hooked: boolean; started: boolean; ended: boolean; error: boolean;
  active: boolean; activeConf: Confidence; stopAt: number | null; stopConf: Confidence; idle: Confidence | null;
  outcome: string | null;
  requests: Map<string, 'permission' | 'input'>;
  inflight: Map<string, { at: number; agentTool: boolean }>;
  lastTool: string | null; reqSeq: number;
  children: Set<string>; bgTurn: boolean; background: boolean;
  tools: Set<string>; turnIds: Set<string>; typed: { confirmed: number; inferred: number };
  usage: Map<string, Record<string, number>>;
  lastTs: number; lastFileTs: number;
  /** Calls started by the authoritative source, waiting for their end: id -> args signature and tool (R2–R4). */
  calls: Map<string, { sig: string | undefined; tool: string }>;
  pat: Patterns;
  /** Calls that ended (or were rejected): a start delivered after its own end never runs again (P3-T13a). */
  done: Set<string>;
  model: string | null; effort: string | null;
}
const fresh = (): Fold => ({
  hooked: false, started: false, ended: false, error: false, active: false, activeConf: 'inferred', stopAt: null, stopConf: 'inferred',
  idle: null, outcome: null, requests: new Map(), inflight: new Map(), lastTool: null, reqSeq: 0, children: new Set(), bgTurn: false,
  background: false, tools: new Set(), turnIds: new Set(), typed: { confirmed: 0, inferred: 0 }, usage: new Map(), lastTs: -Infinity,
  lastFileTs: -Infinity, calls: new Map(), pat: freshPatterns(), done: new Set(), model: null, effort: null,
});

function activate(f: Fold, conf: Confidence) {
  f.active = true; f.activeConf = conf; f.stopAt = null; f.idle = null; f.error = false;
}

/** Applies one entry. `conflict` is told when file evidence is outranked by the session's hooks. R2–R4 follow only the
 * authoritative source (hooks once the session has any, else files), so a call seen by both counts once and signatures
 * from different sources are never compared. */
function step(f: Fold, x: Entry, r: RuleSettings, conflict?: (kind: string) => void) {
  const inferred = x.conf === 'inferred';
  if (!inferred) f.hooked = true;
  const ignored = inferred && f.hooked; // hooks outrank file inference (§5.5)
  for (const e of x.evs) {
    if (inferred && CONFIRMED_ONLY.has(e.k)) continue;
    switch (e.k) {
      case 'session.start':
        // A resume after SessionEnd starts a new invocation of the same session (G3c-2): totals stay, live state resets.
        if (f.ended) {
          Object.assign(f, { ended: false, active: false, stopAt: null, idle: null, error: false, outcome: null, bgTurn: false, background: false });
          f.requests.clear(); f.inflight.clear(); f.children.clear(); f.calls.clear(); f.pat = freshPatterns();
        }
        f.started = true;
        break;
      case 'session.end': f.ended = true; break;
      case 'turn.start':
        if (e.turn) f.turnIds.add(e.turn); else if (e.typed) f.typed[x.conf]++;
        if (!ignored) { activate(f, x.conf); f.outcome = null; f.pat = freshPatterns(); f.calls.clear(); }
        break;
      case 'activity':
        if (!ignored && !f.active && (e.reopen || (f.stopAt === null && f.idle === null && !f.error))) activate(f, x.conf);
        break;
      case 'model':
        if (e.id) f.model = e.id;
        if (e.effort) f.effort = e.effort;
        break;
      case 'tool.start':
        f.tools.add(e.id);
        if (e.child || f.done.has(e.id)) break;
        if (!inferred) f.lastTool = e.id;
        if (!f.inflight.has(e.id)) f.inflight.set(e.id, { at: x.ts, agentTool: e.tool === 'Agent' || e.tool === 'Task' });
        if (e.background) f.bgTurn = true;
        if (!ignored) f.calls.set(e.id, { sig: e.sig, tool: e.tool ?? '' });
        if (!ignored && !f.active) activate(f, x.conf);
        break;
      case 'tool.end': {
        // Only a confirmed end marks the call done: a transcript end sorted before the hook start must not swallow it (review M1).
        f.tools.add(e.id); f.inflight.delete(e.id); f.requests.delete(e.id); if (!inferred) f.done.add(e.id);
        const c = f.calls.get(e.id);
        if (c && !ignored) {
          f.calls.delete(e.id);
          // An unknown args or result signature matches nothing, so it breaks the pattern. An error without text
          // compares tool and args; with text, tool and error (§6.4 "same tool/error signature").
          const unknown = `?${e.id}`;
          const call = c.sig && e.sig ? `${c.sig}:${e.sig}` : unknown;
          onCall(f.pat, r, call, e.err ? (e.sig ? `${c.tool}:${e.sig}` : c.sig ?? unknown) : null);
        }
        break;
      }
      case 'tool.rejected':
        f.tools.add(e.id);
        if (!f.inflight.has(e.id)) break; // only a call still in flight can be denied or interrupted
        f.inflight.delete(e.id); f.requests.delete(e.id); f.calls.delete(e.id); f.done.add(e.id); f.pat = freshPatterns();
        f.active = false; f.stopAt = null; f.idle = 'inferred'; f.outcome = 'interrupted';
        break;
      case 'request':
        f.requests.set(e.id ?? f.lastTool ?? `request-${++f.reqSeq}`, e.kind);
        if (!f.active) activate(f, x.conf);
        break;
      case 'resolve':
        if (f.requests.delete(e.id) && e.outcome) f.outcome = e.outcome;
        break;
      case 'turn.end':
        if (ignored) { conflict?.(e.k); break; }
        f.active = false; f.stopAt = x.ts; f.stopConf = x.conf; f.idle = null; f.background = f.bgTurn; f.bgTurn = false;
        break;
      case 'turn.idle':
        if (ignored) { conflict?.(e.k); break; }
        f.active = false; f.stopAt = null; f.idle = x.conf;
        break;
      case 'turn.error':
        if (ignored) break;
        f.error = true; f.active = false; f.stopAt = null;
        break;
      case 'interrupt':
        f.active = false; f.stopAt = x.ts; f.stopConf = x.conf; f.outcome = 'interrupted'; f.background = false; f.bgTurn = false;
        break;
      case 'child.start': // a subagent is work, even with no prompt first (G3c-4)
        f.children.add(e.id);
        if (!ignored && !f.active && f.stopAt === null && !f.error) activate(f, x.conf);
        break;
      case 'child.end':
        if (f.children.delete(e.id) && f.children.size === 0 && !f.active && f.stopAt !== null) f.stopAt = x.ts;
        break;
      case 'usage': f.usage.set(e.key, e.usage); break;
    }
    if (!ignored && TURN_ENDS.has(e.k)) f.pat = freshPatterns(); // R2–R4 belong to the turn that ended (review)
  }
  f.lastTs = Math.max(f.lastTs, x.ts);
  if (inferred) f.lastFileTs = Math.max(f.lastFileTs, x.ts);
}

type Life = Pick<SessionStatus, 'lifecycle' | 'confidence' | 'reason'>;
function life(f: Fold, agent: string, now: number, settleMs: number): Life {
  const L = (lifecycle: Lifecycle, confidence: Confidence, reason: string | null = null): Life => ({ lifecycle, confidence, reason });
  if (f.ended) return L('ended', 'confirmed');
  if (f.requests.size) return L([...f.requests.values()].at(-1) === 'input' ? 'needs-input' : 'waiting-for-permission', 'confirmed');
  if (f.error) return L('error', 'confirmed');
  if (f.idle) return L('idle', f.idle);
  if (f.active) {
    // §6.2 no-hook row: a pending non-Agent call for > 5 s with no file writes since.
    if (agent === 'claude' && !f.hooked) {
      let oldest = Infinity;
      for (const t of f.inflight.values()) if (!t.agentTool && t.at < oldest) oldest = t.at;
      if (oldest < Infinity && now - Math.max(oldest, f.lastFileTs) > HEURISTIC_MS) return L('waiting-for-permission', 'heuristic', 'Probably waiting');
    }
    return L('busy', f.activeConf);
  }
  if (f.stopAt !== null) {
    if (f.children.size || now - f.stopAt < settleMs) return L('busy', f.stopConf, 'Finishing…');
    return f.background ? L('busy', f.stopConf, 'Background work') : L('idle', f.stopConf);
  }
  return f.started ? L('idle', 'confirmed') : L('unknown', 'inferred');
}

function usageOf(f: Fold): Record<string, number> | null {
  if (!f.usage.size) return null;
  const out: Record<string, number> = {};
  for (const u of f.usage.values()) for (const [k, v] of Object.entries(u)) out[k] = (Object.hasOwn(out, k) ? out[k]! : 0) + v;
  return out;
}

/** top: per producer key the highest producer_seq and the latest ordering time, so a report newest in both skips the
 *  neighbour search (review L1). */
interface Sess { agent: string; entries: Entry[]; dedup: Set<string>; fold: Fold; top: Map<string, { seq: number; ts: number }> }
const raise = (s: Sess, x: Entry) => {
  const t = s.top.get(x.pid!);
  s.top.set(x.pid!, { seq: Math.max(t?.seq ?? -Infinity, x.pseq!), ts: Math.max(t?.ts ?? -Infinity, x.ts) });
};
const after = (a: Entry, b: Entry) => a.ts - b.ts || a.rank - b.rank || a.seq - b.seq || (a.pseq ?? 0) - (b.pseq ?? 0);

export function createEngine(o: EngineOptions): StatusEngine {
  const put = o.db.prepare(`INSERT OR IGNORE INTO status_evidence (agent, profile_id, native_session_id, dedup, ts, rank, seq, confidence, ev,
    producer_id, producer_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // ponytail: every session's evidence stays in memory and is reloaded at start, and an out-of-order delivery refolds the
  // session (O(n)). Feeders must stamp file lines with their read time (in order, as the tailer does), or a backfill behind
  // existing hook entries costs O(n²). Compact settled sessions to a snapshot and fold from the insertion point when
  // retention, session counts or a hostile local hook client make that matter.
  const rules: RuleSettings = { ...RULE_DEFAULTS, ...o.rules };
  const maps = statusMaps(o.catalog ?? loadCatalog());
  const sessions = new Map<string, Sess>();
  const key = (agent: string, profile: string, sid: string) => `${agent}\0${profile}\0${sid}`;
  const get = (agent: string, profile: string, sid: string) => {
    let s = sessions.get(key(agent, profile, sid));
    if (!s) sessions.set(key(agent, profile, sid), (s = { agent, entries: [], dedup: new Set(), fold: fresh(), top: new Map() }));
    return s;
  };
  let seq = 0;
  // Rows stored before 011 have profile '' (a session no profile reads) and no producer: harmless derived data.
  for (const r of o.db.prepare(`SELECT agent, profile_id AS profile, native_session_id AS sid, dedup, ts, rank, seq, confidence, ev, producer_id AS pid,
    producer_seq AS pseq FROM status_evidence ORDER BY ts, rank, seq, coalesce(producer_seq, 0), id`).all() as
    { agent: string; profile: string; sid: string; dedup: string; ts: number; rank: number; seq: number; confidence: 'confirmed' | 'inferred'; ev: string;
      pid: string | null; pseq: number | null }[]) {
    const s = get(r.agent, r.profile, r.sid);
    s.dedup.add(r.dedup);
    try {
      const evs: unknown = JSON.parse(r.ev);
      if (!Array.isArray(evs) || !evs.every((e) => e && typeof e === 'object' && typeof e.k === 'string')) throw new Error('shape');
      const x: Entry = { ts: r.ts, rank: r.rank, seq: r.seq, conf: r.confidence, evs: evs as Ev[], ...(r.pid !== null && r.pseq !== null ? { pid: r.pid, pseq: r.pseq } : {}) };
      step(s.fold, x, rules); s.entries.push(x);
      if (x.pid !== undefined) raise(s, x);
    } catch { o.log('status_row_skipped'); } // one corrupt row never stops startup
    seq = Math.max(seq, r.rank === 0 ? r.seq : 0);
  }
  let suspendedAt: number | null = null;
  // ponytail: suspended intervals live in memory, so a restart forgets earlier sleeps; persist them if R1/R5 must hold
  // across a restart that follows a sleep inside one long call (P3-T12 owns the sleep/wake source).
  const sleeps: [number, number][] = [];

  const ingest = (obs: Observation) => {
    if (obs.source === 'otel') return; // OTel never drives status (§6.6)
    const hookish = obs.source !== 'file';
    const agent = hookish ? obs.envelope.agent : obs.agent;
    const profile = hookish ? obs.envelope.profile_key : obs.profile;
    const sid = hookish ? obs.envelope.session_id : obs.sessionId;
    // Report events map by the report contract whatever agent the registration binds (§5.10); hooks and files by agent.
    const map: StatusMap | undefined = obs.source === 'report' ? (x) => (x.source === 'report' ? reportEvidence(x.envelope) : null) : maps.get(agent);
    if (!sid || !map) return; // agents without a status map are not tracked
    // A file is keyed by a hash of its path, so no path is stored (security review).
    const dedup = hookish ? `d:${obs.envelope.delivery_id}` : `f:${createHash('sha256').update(obs.file).digest('hex').slice(0, 16)}:${obs.offset}`;
    if (sessions.get(key(agent, profile, sid))?.dedup.has(dedup)) return;
    let evs: Ev[];
    try {
      const mapped = map(obs);
      if (mapped === null) { o.log('status_unmapped'); return; } // reduced coverage: no invented state (§6.8)
      evs = mapped.slice(0, MAX_EVS);
    } catch { o.log('status_map_failed'); return; } // no session, nothing stored
    const s = get(agent, profile, sid);
    s.dedup.add(dedup);
    const x: Entry = hookish
      ? { ts: obs.envelope.received_ts, rank: 0, seq: ++seq, conf: 'confirmed', evs }
      : { ts: obs.receivedTs, rank: 1, seq: obs.offset, conf: 'inferred', evs };
    if (obs.source === 'report') {
      // Report intake stamps arrival time (a replay, the helper's), so producer_seq is the causal order within one producer
      // (§5.10: timestamps do not override it). Every report sits between its producer's neighbours: one sorting before
      // its latest lower-seq entry takes that entry's place, one sorting after its earliest higher-seq entry takes that
      // one's, and producer_seq, the last sort key, settles the tie (G3f-1). A producer is scoped to its registration (the
      // intake's delivery id is `<registration>:<id>`), so one registration never reorders another's events (review L2).
      const p = obs.envelope.payload ?? {}, id = p['producer_id'], pseq = p['producer_seq'];
      if (typeof id === 'string' && Number.isSafeInteger(pseq)) {
        const d = obs.envelope.delivery_id, pid = `${d.includes(':') ? d.slice(0, d.indexOf(':')) : ''}:${id}`;
        x.pid = pid; x.pseq = pseq as number;
        const top = s.top.get(pid);
        if (top && (x.pseq <= top.seq || x.ts < top.ts)) { // not newest in both seq and time: find its neighbours
          let prev: Entry | undefined, next: Entry | undefined;
          for (const e of s.entries) {
            if (e.pid !== pid) continue;
            if (e.pseq! < x.pseq && (!prev || after(e, prev) > 0)) prev = e;
            if (e.pseq! > x.pseq && (!next || after(e, next) < 0)) next = e;
          }
          if (prev && after(x, prev) < 0) { x.ts = prev.ts; x.seq = prev.seq; }
          else if (next && after(x, next) > 0) { x.ts = next.ts; x.seq = next.seq; }
        }
        raise(s, x);
      }
    }
    const received = hookish ? obs.envelope.received_ts : x.ts; // the receipt time, before any reordering (G3f-2)
    try { put.run(agent, profile, sid, dedup, x.ts, x.rank, x.seq, x.conf, JSON.stringify(x.evs), x.pid ?? null, x.pseq ?? null); } catch { o.log('status_store_failed'); }
    const pending = new Set(s.fold.requests.keys());
    let i = s.entries.length;
    while (i > 0 && after(s.entries[i - 1]!, x) > 0) i--;
    s.entries.splice(i, 0, x);
    if (i === s.entries.length - 1) step(s.fold, x, rules, (kind) => o.log(`status_conflict agent=${agent} kind=${kind}`));
    else { s.fold = fresh(); for (const e of s.entries) step(s.fold, e, rules); } // out of order: refold in causal order
    // Notify intent: only an entry that carries a request, and only for a request id pending now that was not before
    // (one prompt reported twice, a refold of earlier evidence or a late request already resolved in causal order sends
    // nothing; request ids derived from fold order are never remembered, review M1/M2). An entry received more than
    // NOTIFY_MAX_AGE_MS ago (a spool replayed after an outage) is stale: its resolution is likely already queued (M3).
    // Age is the receipt time: a live request placed before a newer event of its producer is still new (G3f-2).
    if (s.fold.ended || !x.evs.some((e) => e.k === 'request') || o.now() - received > NOTIFY_MAX_AGE_MS) return;
    for (const [id, kind] of s.fold.requests) {
      if (!pending.has(id)) o.onWait?.(agent, profile, sid, kind === 'input' ? 'needs-input' : 'waiting-for-permission');
    }
  };

  const status = (agent: string, profile: string, sid: string): SessionStatus | null => {
    const s = sessions.get(key(agent, profile, sid));
    if (!s) return null;
    const f = s.fold, now = o.now();
    const l = life(f, agent, now, o.settleMs);
    const findings = [...f.pat.found.keys()];
    // R1: busy in a turn with no known wait (call, request, subagent, background work) and no evidence for too long.
    if (l.lifecycle === 'busy' && l.reason === null && !f.inflight.size && !f.children.size
      && awake(f.lastTs, now, sleeps) > rules.noProgressMs) findings.push('R1');
    // R5: a call in flight too long, while the session works (or may be waiting, heuristically). An Agent/Task call
    // counts: a subagent running that long shows "long-running tool". A confirmed permission or input wait is not busy,
    // so a slow answer never reads as a long tool.
    if ((l.lifecycle === 'busy' || l.confidence === 'heuristic')
      && [...f.inflight.values()].some((t) => awake(t.at, now, sleeps) > rules.longToolMs)) findings.push('R5');
    return {
      ...l,
      settleAt: l.reason === 'Finishing…' && !f.children.size && f.stopAt !== null ? f.stopAt + o.settleMs : null,
      health: suspendedAt !== null && f.lastTs <= suspendedAt ? 'stale' : 'connected',
      outcome: f.outcome, findings: findings.sort(), toolCalls: f.tools.size, turns: f.turnIds.size + Math.max(f.typed.confirmed, f.typed.inferred),
      usage: usageOf(f), model: f.model, effort: f.effort,
    };
  };

  return {
    ingest, status,
    advance: () => {},
    // A second suspend while asleep is the same sleep: health and the R1/R5 exclusion keep its first start (P3-T12 review).
    suspend: (now) => { if (sleeps.at(-1)?.[1] !== Infinity) { suspendedAt = now; sleeps.push([now, Infinity]); } },
    resume: (now) => { const last = sleeps.at(-1); if (last?.[1] === Infinity) last[1] = now; },
    close: () => {},
  };
}
