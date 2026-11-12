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
import { claudeEvidence } from '../adapters/claude/status-map.ts';
import { codexEvidence } from '../adapters/codex/status-map.ts';

export type Lifecycle = 'idle' | 'busy' | 'waiting-for-permission' | 'needs-input' | 'error' | 'ended' | 'unknown';
export type Confidence = 'confirmed' | 'inferred' | 'heuristic';
export type Health = 'connected' | 'stale' | 'detached';

export interface SessionStatus {
  lifecycle: Lifecycle; confidence: Confidence; health: Health;
  /** 'Finishing…', 'Background work', 'Probably waiting', or null. */
  reason: string | null;
  /** Outcome of the last turn or request: 'interrupted', 'denied', 'declined', 'cancelled', or null. */
  outcome: string | null;
  /** Active finding rule ids (P3-T09). */
  findings: string[];
  toolCalls: number; turns: number;
  usage: Record<string, number> | null;
  model: string | null; effort: string | null;
}

export type Observation =
  | { source: 'hook' | 'report'; envelope: Envelope }
  | { source: 'file'; agent: string; sessionId: string; file: string; offset: number; line: string; receivedTs: number }
  | { source: 'otel'; agent: string; sessionId: string; record: unknown; receivedTs: number };

export interface StatusEngine {
  ingest(o: Observation): void;
  /** The clock moved; status is read against `now()`, so nothing is scheduled here. */
  advance(now: number): void;
  suspend(now: number): void;
  resume(now: number): void;
  status(agent: string, sessionId: string): SessionStatus | null;
  close(): void;
}
export interface EngineOptions { db: DatabaseSync; now: () => number; settleMs: number; log: (line: string) => void }

/** Normalized evidence, the output of an agent's status map. Ids are native ids; nothing here is content. */
export type Ev =
  | { k: 'session.start' } | { k: 'session.end' }
  | { k: 'turn.start'; typed: boolean; turn?: string }
  | { k: 'activity' }
  | { k: 'tool.start'; id: string; tool?: string; background?: true; child?: true }
  | { k: 'tool.end'; id: string }
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

// A Map, so an agent name such as `constructor` can never reach Object.prototype (security review).
const MAPS = new Map<string, (o: Observation) => Ev[]>([['claude', claudeEvidence], ['codex', codexEvidence]]);
const HEURISTIC_MS = 5000;
/** Evidence kept per observation: bounds what one adversarial line or payload can add. */
const MAX_EVS = 256;
/** Evidence a file record may never produce: only a hook or report confirms these (§6.1-§6.3). */
const CONFIRMED_ONLY = new Set<Ev['k']>(['session.start', 'session.end', 'request', 'resolve', 'turn.error', 'interrupt']);

interface Entry { ts: number; rank: number; seq: number; conf: 'confirmed' | 'inferred'; evs: Ev[] }
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
}
const fresh = (): Fold => ({
  hooked: false, started: false, ended: false, error: false, active: false, activeConf: 'inferred', stopAt: null, stopConf: 'inferred',
  idle: null, outcome: null, requests: new Map(), inflight: new Map(), lastTool: null, reqSeq: 0, children: new Set(), bgTurn: false,
  background: false, tools: new Set(), turnIds: new Set(), typed: { confirmed: 0, inferred: 0 }, usage: new Map(), lastTs: -Infinity,
  lastFileTs: -Infinity,
});

function activate(f: Fold, conf: Confidence) {
  f.active = true; f.activeConf = conf; f.stopAt = null; f.idle = null; f.error = false;
}

/** Applies one entry. `conflict` is told when file evidence is outranked by the session's hooks. */
function step(f: Fold, x: Entry, conflict?: (kind: string) => void) {
  const inferred = x.conf === 'inferred';
  if (!inferred) f.hooked = true;
  const ignored = inferred && f.hooked; // hooks outrank file inference (§5.5)
  for (const e of x.evs) {
    if (inferred && CONFIRMED_ONLY.has(e.k)) continue;
    switch (e.k) {
      case 'session.start': f.started = true; break;
      case 'session.end': f.ended = true; break;
      case 'turn.start':
        if (e.turn) f.turnIds.add(e.turn); else if (e.typed) f.typed[x.conf]++;
        if (!ignored) { activate(f, x.conf); f.outcome = null; }
        break;
      case 'activity':
        if (!ignored && !f.active && f.stopAt === null && f.idle === null && !f.error) activate(f, x.conf);
        break;
      case 'tool.start':
        f.tools.add(e.id);
        if (e.child) break;
        if (!inferred) f.lastTool = e.id;
        if (!f.inflight.has(e.id)) f.inflight.set(e.id, { at: x.ts, agentTool: e.tool === 'Agent' || e.tool === 'Task' });
        if (e.background) f.bgTurn = true;
        if (!ignored && !f.active) activate(f, x.conf);
        break;
      case 'tool.end':
        f.tools.add(e.id); f.inflight.delete(e.id); f.requests.delete(e.id);
        break;
      case 'tool.rejected':
        f.tools.add(e.id);
        if (!f.inflight.has(e.id)) break; // only a call still in flight can be denied or interrupted
        f.inflight.delete(e.id); f.requests.delete(e.id);
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
      case 'child.start': f.children.add(e.id); break;
      case 'child.end':
        if (f.children.delete(e.id) && f.children.size === 0 && !f.active && f.stopAt !== null) f.stopAt = x.ts;
        break;
      case 'usage': f.usage.set(e.key, e.usage); break;
    }
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
  for (const u of f.usage.values()) for (const [k, v] of Object.entries(u)) out[k] = (out[k] ?? 0) + v;
  return out;
}

interface Sess { agent: string; entries: Entry[]; dedup: Set<string>; fold: Fold }
const after = (a: Entry, b: Entry) => a.ts - b.ts || a.rank - b.rank || a.seq - b.seq;

export function createEngine(o: EngineOptions): StatusEngine {
  const put = o.db.prepare(`INSERT OR IGNORE INTO status_evidence (agent, native_session_id, dedup, ts, rank, seq, confidence, ev)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  // ponytail: every session's evidence stays in memory and is reloaded at start, and an out-of-order delivery refolds the
  // session (O(n)). Feeders must stamp file lines with their read time (in order, as the tailer does), or a backfill behind
  // existing hook entries costs O(n²). Compact settled sessions to a snapshot and fold from the insertion point when
  // retention, session counts or a hostile local hook client make that matter.
  const sessions = new Map<string, Sess>();
  const key = (agent: string, sid: string) => `${agent}\0${sid}`;
  const get = (agent: string, sid: string) => {
    let s = sessions.get(key(agent, sid));
    if (!s) sessions.set(key(agent, sid), (s = { agent, entries: [], dedup: new Set(), fold: fresh() }));
    return s;
  };
  let seq = 0;
  for (const r of o.db.prepare('SELECT agent, native_session_id AS sid, dedup, ts, rank, seq, confidence, ev FROM status_evidence ORDER BY ts, rank, seq, id').all() as
    { agent: string; sid: string; dedup: string; ts: number; rank: number; seq: number; confidence: 'confirmed' | 'inferred'; ev: string }[]) {
    const s = get(r.agent, r.sid);
    s.dedup.add(r.dedup);
    try {
      const evs: unknown = JSON.parse(r.ev);
      if (!Array.isArray(evs) || !evs.every((e) => e && typeof e === 'object' && typeof e.k === 'string')) throw new Error('shape');
      const x: Entry = { ts: r.ts, rank: r.rank, seq: r.seq, conf: r.confidence, evs: evs as Ev[] };
      step(s.fold, x); s.entries.push(x);
    } catch { o.log('status_row_skipped'); } // one corrupt row never stops startup
    seq = Math.max(seq, r.rank === 0 ? r.seq : 0);
  }
  let suspendedAt: number | null = null;

  const ingest = (obs: Observation) => {
    if (obs.source === 'otel') return; // OTel never drives status (§6.6)
    const hookish = obs.source !== 'file';
    const agent = hookish ? obs.envelope.agent : obs.agent;
    const sid = hookish ? obs.envelope.session_id : obs.sessionId;
    const map = MAPS.get(agent);
    if (!sid || !map) return; // agents without a status map are not tracked (agy and report: P3-T13)
    // A file is keyed by a hash of its path, so no path is stored (security review).
    const dedup = hookish ? `d:${obs.envelope.delivery_id}` : `f:${createHash('sha256').update(obs.file).digest('hex').slice(0, 16)}:${obs.offset}`;
    if (sessions.get(key(agent, sid))?.dedup.has(dedup)) return;
    let evs: Ev[];
    try { evs = map(obs).slice(0, MAX_EVS); } catch { o.log('status_map_failed'); return; } // no session, nothing stored
    const s = get(agent, sid);
    s.dedup.add(dedup);
    const x: Entry = hookish
      ? { ts: obs.envelope.received_ts, rank: 0, seq: ++seq, conf: 'confirmed', evs }
      : { ts: obs.receivedTs, rank: 1, seq: obs.offset, conf: 'inferred', evs };
    try { put.run(agent, sid, dedup, x.ts, x.rank, x.seq, x.conf, JSON.stringify(x.evs)); } catch { o.log('status_store_failed'); }
    let i = s.entries.length;
    while (i > 0 && after(s.entries[i - 1]!, x) > 0) i--;
    s.entries.splice(i, 0, x);
    if (i === s.entries.length - 1) step(s.fold, x, (kind) => o.log(`status_conflict agent=${agent} kind=${kind}`));
    else { s.fold = fresh(); for (const e of s.entries) step(s.fold, e); } // out of order: refold in causal order
  };

  const status = (agent: string, sid: string): SessionStatus | null => {
    const s = sessions.get(key(agent, sid));
    if (!s) return null;
    const f = s.fold;
    return {
      ...life(f, agent, o.now(), o.settleMs),
      health: suspendedAt !== null && f.lastTs <= suspendedAt ? 'stale' : 'connected',
      outcome: f.outcome, findings: [], toolCalls: f.tools.size, turns: f.turnIds.size + Math.max(f.typed.confirmed, f.typed.inferred),
      usage: usageOf(f), model: null, effort: null,
    };
  };

  return {
    ingest, status,
    advance: () => {},
    suspend: (now) => { suspendedAt = now; },
    resume: () => {},
    close: () => {},
  };
}
