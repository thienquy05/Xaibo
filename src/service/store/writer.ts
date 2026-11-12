// Single-writer batches (P1-T07): records commit together with their source-file checkpoint in one transaction;
// live batches are committed ahead of backfill; flush at the S12 bounds (100 rows, 1 MiB or 50 ms).
import type { DatabaseSync } from 'node:sqlite';
import { byRank, mergeToolCalls, type ToolCallObservation } from '../normalize.ts';
import { cwdKey } from '../paths.ts';
import { agyUsage, claudeUsage, codexRateLimits, codexStep, codexUsage, tokenRecordDrift, type Usage } from '../usage/tokens.ts';
import { contextStep, type ContextObs, type Snapshot } from '../usage/context.ts';

export const SCHEMA_VERSION = 1;
const FTS_MAX_BYTES = 64 * 1024;

export interface SourceFileCheckpoint {
  path: string; kind: string; dev: number; ino: number; size: number; mtime: number; offset: number; headHash: string;
  status: 'ok' | 'compressed_not_imported' | 'gone' | 'oversized';
}
export interface SessionUpsert {
  nativeSessionId: string; cwd?: string; cwdKey?: string; entrypoint?: string; interactive?: boolean; title?: string;
  startedAt?: number; lastActivity?: number; originator?: string; nativeArchived?: boolean;
  /** P2-T11 (EC-81): false once the native conversation is verifiably gone; true again when it reappears. */
  nativeAvailable?: boolean;
  /** Every distinct cwd the batch saw (P2-T05, EC-06): cwd_history rows, never a second session. */
  cwds?: CwdSeen[];
}
export interface CwdSeen { cwd: string; cwdKey: string; firstSeen?: number; source: string }
export interface EventRow {
  nativeSessionId: string; source: string; confidence: string; nativeId: string; parentNativeId?: string; messageId?: string;
  kind: string; role?: string; subagentNativeId?: string; byteOffset?: number; sourceSeq: number; sourceTs?: number;
  fileMtime?: number; receivedTs: number; ingestId?: string; injected?: boolean; content?: string; raw?: string;
  /** P2-T05: native tool-call ids this record carries (call = args, output = result) and the turn edge it marks. */
  toolCalls?: { callId: string; part: 'args' | 'result'; tool?: string }[];
  turn?: { id: string; edge: 'start' | 'end'; outcome?: string };
  /** P2-T06: raw usage this record carries; normalized and written by usage() below. */
  usage?: UsageObs;
  /** P2-T08: model evidence (effort undefined = not exposed); `turn` names the turn it belongs to when the record says. */
  model?: { id: string; effort?: string | null; turn?: string };
  /** P2-T07: a context observation; a Codex one with model null takes the session's current model at write time. */
  context?: ContextObs;
  /** P2-T11 (EC-80, agy): apply in source order by sourceSeq: current rows of the session with seq >= this one become
   *  superseded (same seq) or rewound (higher), and this row is current again if it was stored before. */
  revise?: boolean;
}
type Obj = Record<string, unknown>;
export type UsageObs =
  | { kind: 'claude'; messageId: string; model?: string; raw: Obj }
  | { kind: 'codex-count'; total?: Obj; last?: Obj; rateLimits?: Obj }
  | { kind: 'codex-record'; payload: Obj }
  | { kind: 'agy'; identity: string; raw: Obj };
export interface QuarantineRow { nativeSessionId?: string; byteOffset: number; reason: string; raw?: Uint8Array; receivedTs: number }
export interface SubagentLink { nativeSessionId: string; nativeId: string; agentType?: string }
export interface Batch {
  /** Absent for hook deliveries (P3-T04): they carry no source file checkpoint. */
  profileId: string; agent: string; file?: SourceFileCheckpoint; fileSession?: string;
  sessions: SessionUpsert[]; events: EventRow[]; quarantine?: QuarantineRow[]; subagents?: SubagentLink[];
  /** P3-T04 (EC-09): the hook delivery this batch commits; a delivery_id already stored commits nothing else. */
  delivery?: HookDelivery;
  /** P3-T13b (§5.10): the report delivery this batch commits; a (registration, delivery_id) already stored commits nothing else. */
  report?: ReportDelivery;
}
export interface ReportDelivery {
  registrationId: string; deliveryId: string; agent: string; profileKey: string; nativeSessionId: string; event: string;
  producerId: string; producerSeq: number; receivedTs: number; committedTs: number; unattributed: 'unknown-profile' | null;
  /** The content.upsert item this delivery advanced; a settled (complete or incomplete) item is never changed. */
  content?: { itemId: string; revision: number; role: string; kind: string; state: 'pending' | 'complete' | 'incomplete'; chunks: number; bytes: number; text: string | null };
}
export interface HookDelivery {
  deliveryId: string; agent: string; profileKey: string; nativeSessionId: string | null; event: string;
  receivedTs: number; committedTs: number; unattributed: 'unknown-profile' | 'no-session' | null;
}

/** Adds a cwd to the session's batch history, keeping its earliest timestamp (EC-06). */
export function noteCwd(s: SessionUpsert, cwd: string, ts: number | undefined, source: string): void {
  const seen = (s.cwds ??= []).find((c) => c.cwd === cwd);
  if (!seen) s.cwds.push({ cwd, cwdKey: cwdKey(cwd), source, ...(ts !== undefined ? { firstSeen: ts } : {}) });
  else if (ts !== undefined && (seen.firstSeen === undefined || ts < seen.firstSeen)) seen.firstSeen = ts;
}

/** UTF-8-safe byte prefix for the FTS index (never splits a code point). */
export function ftsPrefix(text: string, maxBytes = FTS_MAX_BYTES): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // back up over continuation bytes
  return buf.subarray(0, end).toString('utf8');
}

const b = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
/** A Codex thread_settings record that states an explicit service tier (D-P2-08). */
const codexTierIn = (raw: string | undefined) => {
  try { return typeof (JSON.parse(raw ?? '') as { payload?: { thread_settings?: { service_tier?: unknown } } }).payload?.thread_settings?.service_tier === 'string'; } catch { return false; }
};

// Prepared once per connection (§7.4 cached prepared statements).
const cache = new WeakMap<DatabaseSync, ReturnType<typeof prepare>>();
const statements = (db: DatabaseSync) => cache.get(db) ?? cache.set(db, prepare(db)).get(db)!;

function prepare(db: DatabaseSync) {
  return {
    // ponytail: native_archived only rises (a rollout seen under archived_sessions/); unarchiving needs a scan-level check.
    upsertSession: db.prepare(`INSERT INTO sessions (agent, profile_id, native_session_id, cwd, cwd_key, entrypoint, interactive, title, started_at, last_activity,
        originator, native_archived, native_available)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, 1))
      ON CONFLICT (agent, profile_id, native_session_id) DO UPDATE SET
        cwd = coalesce(sessions.cwd, excluded.cwd), cwd_key = coalesce(sessions.cwd_key, excluded.cwd_key),
        entrypoint = coalesce(sessions.entrypoint, excluded.entrypoint), interactive = coalesce(sessions.interactive, excluded.interactive),
        originator = coalesce(sessions.originator, excluded.originator), native_archived = max(sessions.native_archived, excluded.native_archived),
        native_available = coalesce(?, sessions.native_available),
        title = coalesce(excluded.title, sessions.title),
        started_at = min(coalesce(sessions.started_at, excluded.started_at), coalesce(excluded.started_at, sessions.started_at)),
        last_activity = max(coalesce(sessions.last_activity, excluded.last_activity), coalesce(excluded.last_activity, sessions.last_activity))
      RETURNING id`),
    upsertFile: db.prepare(`INSERT INTO source_files (profile_id, session_id, path, kind, dev, ino, size, mtime, offset, head_hash, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET session_id = coalesce(excluded.session_id, source_files.session_id), kind = excluded.kind,
        dev = excluded.dev, ino = excluded.ino, size = excluded.size, mtime = excluded.mtime, offset = excluded.offset,
        head_hash = excluded.head_hash, status = excluded.status
      RETURNING id`),
    insertEvent: db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, parent_native_id, message_id,
        kind, role, subagent_native_id, file_id, byte_offset, source_seq, source_ts, file_mtime, received_ts, ingest_id, injected, content, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, source, native_id) DO NOTHING RETURNING id`),
    insertFts: db.prepare('INSERT INTO event_fts (rowid, content) VALUES (?, ?)'),
    delivery: db.prepare(`INSERT INTO hook_delivery (delivery_id, agent, profile_key, native_session_id, event, received_ts, committed_ts, unattributed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`),
    report: db.prepare(`INSERT INTO report_delivery (registration_id, delivery_id, agent, profile_key, native_session_id, event, producer_id, producer_seq,
        received_ts, committed_ts, unattributed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING delivery_id`),
    reportContent: db.prepare(`INSERT INTO report_content (registration_id, native_session_id, item_id, revision, role, kind, state, chunks, bytes, content, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET state = excluded.state, chunks = excluded.chunks, bytes = excluded.bytes, content = excluded.content,
        updated_ts = excluded.updated_ts WHERE report_content.state = 'pending'`),
    deleteFts: db.prepare("INSERT INTO event_fts (event_fts, rowid, content) VALUES ('delete', ?, ?)"),
    supersede: db.prepare(`UPDATE events SET revision_status = CASE WHEN source_seq = ? THEN 'superseded' ELSE 'rewound' END
      WHERE session_id = ? AND source = ? AND source_seq >= ? AND revision_status = 'current' AND native_id != ? RETURNING id, content`),
    replaced: db.prepare(`UPDATE events SET revision_status = 'superseded' WHERE session_id = ? AND source = ? AND source_seq = ? AND revision_status = 'rewound'
      AND native_id != ?`),
    revive: db.prepare(`UPDATE events SET revision_status = 'current' WHERE session_id = ? AND source = ? AND native_id = ? AND revision_status != 'current'
      RETURNING id, content`),
    counts: db.prepare(`UPDATE sessions SET record_count = record_count + ?, unknown_count = unknown_count + ?,
      quarantined_count = quarantined_count + ? WHERE id = ?`),
    quarantine: db.prepare(`INSERT INTO quarantine (file_id, byte_offset, reason, raw, received_ts) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (file_id, byte_offset) DO NOTHING RETURNING id`),
    link: db.prepare('INSERT INTO subagents (session_id, native_id, file_id, agent_type) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'),
    drift: db.prepare('UPDATE sessions SET drift = (unknown_count * 20 > record_count) WHERE id = ?'), // EC-04: unknown share > 5%
    cwd: db.prepare(`INSERT INTO cwd_history (session_id, schema_version, source, cwd, cwd_key, first_seen) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, cwd) DO UPDATE SET
        first_seen = min(coalesce(cwd_history.first_seen, excluded.first_seen), coalesce(excluded.first_seen, cwd_history.first_seen))`),
    turn: db.prepare(`INSERT INTO turns (session_id, schema_version, source, native_turn_id, started_at, ended_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, native_turn_id) DO UPDATE SET started_at = coalesce(turns.started_at, excluded.started_at),
        ended_at = coalesce(turns.ended_at, excluded.ended_at), outcome = coalesce(turns.outcome, excluded.outcome)`),
    currentModel: db.prepare(`UPDATE sessions SET current_model = ?, current_effort = ?, current_model_ts = ?
      WHERE id = ? AND (current_model_ts IS NULL OR current_model_ts <= ?)`),
    firstModel: db.prepare('UPDATE sessions SET current_model = ?, current_effort = ? WHERE id = ? AND current_model IS NULL'),
    turnModel: db.prepare(`INSERT INTO turns (session_id, schema_version, source, native_turn_id, model_id, effort) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, native_turn_id) DO UPDATE SET model_id = excluded.model_id, effort = excluded.effort`),
    latestTurnModel: db.prepare(`UPDATE turns SET model_id = ?, effort = ? WHERE model_id IS NULL AND id =
      (SELECT id FROM turns WHERE session_id = ? AND started_at <= ? ORDER BY started_at DESC, id DESC LIMIT 1)`),
    lastContext: db.prepare(`SELECT id, generation, model_id, used_tokens, window_tokens, window_basis, percentage, source, source_locator, as_of
      FROM context_snapshots WHERE session_id = ? ORDER BY generation DESC, id DESC LIMIT 1`),
    sessionModel: db.prepare('SELECT current_model FROM sessions WHERE id = ?'),
    addContext: db.prepare(`INSERT INTO context_snapshots (session_id, schema_version, source, generation, model_id, used_tokens, window_tokens,
        window_basis, percentage, source_locator, as_of, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setContext: db.prepare(`UPDATE context_snapshots SET source = ?, model_id = ?, used_tokens = ?, window_tokens = ?, window_basis = ?,
        percentage = ?, source_locator = ?, as_of = ?, observed_at = ? WHERE id = ?`),
    putUsage: db.prepare(`INSERT INTO usage (session_id, schema_version, source, identity, scope, segment, event_id, model_id, uncached_input,
        cache_read, cache_write, cache_write_classes, output, raw, completeness, source_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, source, scope, identity) DO UPDATE SET segment = excluded.segment, event_id = excluded.event_id,
        model_id = coalesce(excluded.model_id, usage.model_id), uncached_input = excluded.uncached_input, cache_read = excluded.cache_read,
        cache_write = excluded.cache_write, cache_write_classes = excluded.cache_write_classes, output = excluded.output, raw = excluded.raw,
        completeness = excluded.completeness, source_ts = excluded.source_ts`),
    lastSegment: db.prepare(`SELECT segment, json_extract(raw, '$.total_tokens') AS total FROM usage
      WHERE session_id = ? AND source = ? AND scope = 'session' ORDER BY segment DESC LIMIT 1`),
    snapshot: db.prepare(`INSERT INTO usage_snapshots (schema_version, agent, profile_id, session_id, source, source_locator, limit_id, plan,
        credits, windows, as_of, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (profile_id, source, source_locator) DO NOTHING`),
    getCall: db.prepare('SELECT sources, tool, tool_source, args_event_id, result_event_id FROM tool_calls WHERE session_id = ? AND native_call_id = ?'),
    putCall: db.prepare(`INSERT INTO tool_calls (session_id, schema_version, sources, native_call_id, tool, tool_source, args_event_id, result_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, native_call_id) DO UPDATE SET sources = excluded.sources, tool = excluded.tool,
        tool_source = excluded.tool_source, args_event_id = excluded.args_event_id, result_event_id = excluded.result_event_id`),
    // G2-2: priced request rows whose evidence changes are re-priced (with their own revision) by the next pricing pass.
    pricedUsage: db.prepare(`SELECT u.model_id, u.raw FROM usage u
      JOIN cost_estimates e ON e.session_id = u.session_id AND e.covered_scope = 'usage:' || u.source || ':' || u.identity
      WHERE u.session_id = ? AND u.source = ? AND u.scope = 'message' AND u.identity = ?`),
    markDirty: db.prepare("UPDATE cost_estimates SET dirty = 1 WHERE session_id = ? AND covered_scope = ?"),
    markSessionDirty: db.prepare("UPDATE cost_estimates SET dirty = 1 WHERE session_id = ? AND source = ?"),
  };
}

type Row = { sources: string; tool: string | null; tool_source: string | null; args_event_id: number | null; result_event_id: number | null };
/** Merges a new observation into the stored call through mergeToolCalls. The stored tool name is attributed only to the
 *  source that supplied it (G2-6), so precedence and provenance follow one rule whatever order the sources arrive in. */
function putToolCall(st: ReturnType<typeof prepare>, sid: number | bigint, callId: string, o: ToolCallObservation) {
  const prev = st.getCall.get(sid, callId) as Row | undefined;
  const ids = prev ? { ...(prev.args_event_id !== null ? { argsEventId: prev.args_event_id } : {}), ...(prev.result_event_id !== null ? { resultEventId: prev.result_event_id } : {}) } : {};
  const stored: ToolCallObservation[] = prev ? (JSON.parse(prev.sources) as string[])
    .map((source) => ({ source, callId, ...ids, ...(prev.tool !== null && source === prev.tool_source ? { tool: prev.tool } : {}) })) : [];
  const all = [...stored, o];
  const [m] = mergeToolCalls(all);
  const toolSource = all.filter((x) => x.tool !== undefined).sort(byRank)[0]?.source ?? null;
  st.putCall.run(sid, SCHEMA_VERSION, JSON.stringify(m!.sources), callId, m!.tool, toolSource, m!.argsEventId, m!.resultEventId);
}

/** Usage rows and rate-limit snapshots for one newly stored event (P2-T06). Claude: one row per message.id, the latest
 *  line wins. Codex: a segment row (consumption, latest cumulative of the counter segment) and a request row per
 *  advance; duplicates add nothing; a missing rate_limits reading writes no snapshot; a drifted token_usage_record is a
 *  gap row (D-P2-03), never consumption. */
function usage(st: ReturnType<typeof prepare>, batch: Batch, sid: number | bigint, eventId: number | bigint, e: EventRow, u: UsageObs) {
  type Priced = { model_id: string | null; raw: string | null };
  const put = (identity: string, scope: string, segment: number | null, n: Usage | null, raw: Obj, model?: string, gap?: Obj) => {
    const before = scope === 'message' ? st.pricedUsage.get(sid, e.source, identity) as Priced | undefined : undefined;
    const rawText = JSON.stringify(raw);
    st.putUsage.run(sid, SCHEMA_VERSION, e.source, identity, scope, segment, eventId, model ?? null, n?.uncachedInput ?? null, n?.cacheRead ?? null,
      n?.cacheWrite ?? null, n?.cacheWriteClasses ? JSON.stringify(n.cacheWriteClasses) : null, n?.output ?? null, rawText,
      JSON.stringify(gap ?? n!.completeness), e.sourceTs ?? null);
    // G2-2/G2-16: any change to the priced evidence (raw usage, including price qualifiers, or the model) re-prices it.
    if (before && (before.raw !== rawText || (model !== undefined && before.model_id !== model))) st.markDirty.run(sid, `usage:${e.source}:${identity}`);
  };
  if (u.kind === 'claude') put(u.messageId, 'message', null, claudeUsage(u.raw), u.raw, u.model);
  else if (u.kind === 'agy') put(u.identity, 'message', null, agyUsage(u.raw), u.raw); // per step; a rewritten step replaces it
  else if (u.kind === 'codex-record') { if (tokenRecordDrift(u.payload)) put(e.nativeId, 'turn', null, null, u.payload, undefined, { record: 'shape-drift' }); }
  else {
    const total = typeof u.total?.total_tokens === 'number' ? u.total.total_tokens : undefined;
    if (u.total && total !== undefined) {
      const prev = st.lastSegment.get(sid, e.source) as { segment: number; total: number | null } | undefined;
      const step = codexStep(prev && prev.total !== null ? { segment: prev.segment, total: prev.total } : null, total);
      // G2-3: a new segment is stored even when its first reading is zero, so the next reading continues it.
      if (step.advanced || (prev && step.segment !== prev.segment)) put(`segment:${step.segment}`, 'session', step.segment, codexUsage(u.total), u.total);
      if (step.advanced && u.last) put(`${step.segment}:${total}`, 'message', step.segment, codexUsage(u.last), u.last);
    }
    if (u.rateLimits) {
      const r = codexRateLimits(u.rateLimits);
      st.snapshot.run(SCHEMA_VERSION, batch.agent, batch.profileId, sid, e.source, e.nativeId, r.limitId, r.plan,
        r.credits === null ? null : JSON.stringify(r.credits), JSON.stringify(r.windows), e.sourceTs ?? null, e.receivedTs);
    }
  }
}

type CtxRow = { id: number; generation: number; model_id: string | null; used_tokens: number | null; window_tokens: number | null;
  window_basis: Snapshot['basis']; percentage: number | null; source: Snapshot['source']; source_locator: string; as_of: number | null };
/** The latest reading of the current context generation is kept in place; a new generation adds a row (P2-T07). */
function context(st: ReturnType<typeof prepare>, sid: number | bigint, e: EventRow, o: ContextObs) {
  const obs: ContextObs = o.kind === 'codex' && o.model === null
    ? { ...o, model: (st.sessionModel.get(sid) as { current_model: string | null } | undefined)?.current_model ?? null } : o;
  const r = st.lastContext.get(sid) as CtxRow | undefined;
  const prev: Snapshot | null = r ? { generation: r.generation, model: r.model_id, used: r.used_tokens, window: r.window_tokens, basis: r.window_basis,
    percentage: r.percentage, source: r.source, locator: r.source_locator, asOf: r.as_of } : null;
  const n = contextStep(prev, obs);
  if (r && n.generation === r.generation) {
    st.setContext.run(n.source, n.model, n.used, n.window, n.basis, n.percentage, n.locator, n.asOf, e.receivedTs, r.id);
  } else {
    st.addContext.run(sid, SCHEMA_VERSION, n.source, n.generation, n.model, n.used, n.window, n.basis, n.percentage, n.locator, n.asOf, e.receivedTs);
  }
}

export function commitBatch(db: DatabaseSync, batch: Batch): void {
  const st = statements(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const d = batch.delivery;
    if (d && !st.delivery.get(d.deliveryId, d.agent, d.profileKey, d.nativeSessionId, d.event, d.receivedTs, d.committedTs, d.unattributed)) {
      db.exec('COMMIT'); // already stored (spool replay of an acked delivery, or a retry)
      return;
    }
    const r = batch.report;
    if (r) {
      if (!st.report.get(r.registrationId, r.deliveryId, r.agent, r.profileKey, r.nativeSessionId, r.event, r.producerId, r.producerSeq, r.receivedTs,
        r.committedTs, r.unattributed)) { db.exec('COMMIT'); return; }
      const c = r.content;
      if (c) st.reportContent.run(r.registrationId, r.nativeSessionId, c.itemId, c.revision, c.role, c.kind, c.state, c.chunks, c.bytes, c.text, r.committedTs);
    }
    const ids = new Map<string, number | bigint>();
    for (const s of batch.sessions) {
      const row = st.upsertSession.get(batch.agent, batch.profileId, s.nativeSessionId, s.cwd ?? null, s.cwdKey ?? null, s.entrypoint ?? null,
        b(s.interactive), s.title ?? null, s.startedAt ?? null, s.lastActivity ?? null, s.originator ?? null, s.nativeArchived ? 1 : 0,
        b(s.nativeAvailable), b(s.nativeAvailable)) as { id: number };
      ids.set(s.nativeSessionId, row.id);
      for (const c of s.cwds ?? []) st.cwd.run(row.id, SCHEMA_VERSION, c.source, c.cwd, c.cwdKey, c.firstSeen ?? null);
    }
    const sessionId = (nativeId: string) => {
      const id = ids.get(nativeId);
      if (id === undefined) throw new Error('event for a session missing from its batch');
      return id;
    };

    const f = batch.file;
    const file = f ? st.upsertFile.get(batch.profileId, batch.fileSession ? sessionId(batch.fileSession) : null, f.path, f.kind, f.dev, f.ino,
      f.size, f.mtime, f.offset, f.headHash, f.status) as { id: number } : { id: null };

    const added = new Map<number | bigint, [number, number, number]>();
    const bump = (id: number | bigint, i: 0 | 1 | 2) => { const c = added.get(id) ?? [0, 0, 0]; c[i]++; added.set(id, c); };

    type Fts = { id: number; content: string | null };
    for (const e of batch.events) {
      const sid = sessionId(e.nativeSessionId);
      if (e.revise) { // FTS holds current rows only; deletes pass the indexed text (external-content table)
        for (const r of st.supersede.all(e.sourceSeq, sid, e.source, e.sourceSeq, e.nativeId) as Fts[]) if (r.content) st.deleteFts.run(r.id, ftsPrefix(r.content));
        st.replaced.run(sid, e.source, e.sourceSeq, e.nativeId); // rewound earlier in this replay, now replaced by this step
      }
      const row = st.insertEvent.get(sid, SCHEMA_VERSION, e.source, e.confidence, e.nativeId, e.parentNativeId ?? null, e.messageId ?? null,
        e.kind, e.role ?? null, e.subagentNativeId ?? null, file.id, e.byteOffset ?? null, e.sourceSeq, e.sourceTs ?? null,
        e.fileMtime ?? null, e.receivedTs, e.ingestId ?? null, e.injected ? 1 : 0, e.content ?? null, e.raw ?? null) as { id: number } | undefined;
      if (!row) { // already stored (reparse after truncation or rotation); a revised row seen again is current again
        if (e.revise) {
          for (const r of st.revive.all(sid, e.source, e.nativeId) as Fts[]) {
            if (r.content) st.insertFts.run(r.id, ftsPrefix(r.content));
            if (e.usage) usage(st, batch, sid, r.id, e, e.usage);
          }
        }
        continue;
      }
      if (e.content) st.insertFts.run(row.id, ftsPrefix(e.content));
      if (e.turn) {
        const ts = e.sourceTs ?? null;
        st.turn.run(sid, SCHEMA_VERSION, e.source, e.turn.id, e.turn.edge === 'start' ? ts : null, e.turn.edge === 'end' ? ts : null, e.turn.outcome ?? null);
      }
      for (const c of e.toolCalls ?? []) {
        const o: ToolCallObservation = { source: e.source, callId: c.callId, ...(c.tool !== undefined ? { tool: c.tool } : {}) };
        if (c.part === 'args') o.argsEventId = Number(row.id); else o.resultEventId = Number(row.id);
        putToolCall(st, sid, c.callId, o);
      }
      if (e.usage) usage(st, batch, sid, row.id, e, e.usage);
      if (e.model) {
        const effort = e.model.effort ?? null;
        if (e.sourceTs !== undefined) st.currentModel.run(e.model.id, effort, e.sourceTs, sid, e.sourceTs);
        else st.firstModel.run(e.model.id, effort, sid); // no source time: only fills an unknown model, never replaces one
        if (e.model.turn) st.turnModel.run(sid, SCHEMA_VERSION, e.source, e.model.turn, e.model.id, effort);
        else if (e.sourceTs !== undefined) st.latestTurnModel.run(e.model.id, effort, sid, e.sourceTs);
      }
      if (e.context) context(st, sid, e, e.context);
      if (batch.agent === 'codex' && e.kind === 'settings' && codexTierIn(e.raw)) st.markSessionDirty.run(sid, e.source); // G2-2: tier evidence arrived
      if (e.kind.endsWith('-chunk')) continue; // storage of an oversized record (EC-15), not a record: keeps EC-04's ratio
      bump(sid, 0);
      if (e.kind === 'unknown') bump(sid, 1);
    }

    for (const q of file.id === null ? [] : batch.quarantine ?? []) {
      const row = st.quarantine.get(file.id, q.byteOffset, q.reason, q.raw ?? null, q.receivedTs);
      if (row && q.nativeSessionId) bump(sessionId(q.nativeSessionId), 2);
    }

    for (const s of batch.subagents ?? []) st.link.run(sessionId(s.nativeSessionId), s.nativeId, file.id, s.agentType ?? null);

    for (const [id, [records, unknown, quarantined]] of added) {
      st.counts.run(records, unknown, quarantined, id);
      st.drift.run(id);
    }
    db.exec('COMMIT');
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK'); // SQLite already rolled back on SQLITE_FULL; keep that error, not ours
    throw e;
  }
}

/** SQLITE_FULL (primary code 13) or ENOSPC: the store cannot grow (EC-44). */
export const isDiskFull = (e: unknown) => {
  const x = e as { errcode?: unknown; code?: unknown } | null;
  return (typeof x?.errcode === 'number' && (x.errcode & 0xff) === 13) || x?.code === 'ENOSPC';
};

interface Pending { batch: Batch; resolve: () => void; reject: (e: unknown) => void }
export interface WriterOptions {
  maxRows?: number; maxBytes?: number; maxDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => void;
  onCommit?: (batch: Batch) => void;
  /** EC-44: called when the store becomes full and again when a commit succeeds after that, outside any transaction. */
  onDiskFull?: (full: boolean) => void;
  /** Fault injection for tests (Q3-15); commitBatch otherwise. */
  commit?: (db: DatabaseSync, batch: Batch) => void;
}

const batchBytes = (b: Batch) => b.events.reduce((n, e) => n + (e.content?.length ?? 0) + (e.raw?.length ?? 0), 0);

/** Queues batches; live work is committed before backfill. Each batch is its own transaction. */
export class Writer {
  readonly #db: DatabaseSync;
  readonly #o: Required<Omit<WriterOptions, 'onCommit' | 'onDiskFull'>> & Pick<WriterOptions, 'onCommit' | 'onDiskFull'>;
  #full = false;
  #live: Pending[] = [];
  #backfill: Pending[] = [];
  #rows = 0;
  #bytes = 0;
  #timerSet = false;

  constructor(db: DatabaseSync, o: WriterOptions = {}) {
    this.#db = db;
    this.#o = { maxRows: 100, maxBytes: 1 << 20, maxDelayMs: 50, setTimer: (fn, ms) => void setTimeout(fn, ms), commit: commitBatch, ...o };
  }

  /** True from a disk-full commit until the next commit succeeds (EC-44). */
  get diskFull(): boolean { return this.#full; }

  /** A live hook delivery (OQ-A1): its own small transaction now, ahead of anything queued; throws on failure. */
  commitLive(batch: Batch): void {
    this.#commit(batch);
  }

  #commit(batch: Batch): void {
    // ponytail: while full every commit still runs as the probe (SQLite fails fast without growing); a pause timer if
    // the retried file reads ever cost too much.
    try {
      this.#o.commit(this.#db, batch);
    } catch (e) {
      if (isDiskFull(e) && !this.#full) { this.#full = true; this.#o.onDiskFull?.(true); }
      throw e;
    }
    if (this.#full) { this.#full = false; this.#o.onDiskFull?.(false); }
    this.#o.onCommit?.(batch);
  }

  enqueue(batch: Batch, live: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      (live ? this.#live : this.#backfill).push({ batch, resolve, reject });
      this.#rows += batch.events.length;
      this.#bytes += batchBytes(batch);
      if (this.#rows >= this.#o.maxRows || this.#bytes >= this.#o.maxBytes) this.flush();
      else if (!this.#timerSet) {
        this.#timerSet = true;
        this.#o.setTimer(() => { this.#timerSet = false; this.flush(); }, this.#o.maxDelayMs);
      }
    });
  }

  flush(): void {
    const jobs = [...this.#live, ...this.#backfill];
    this.#live = [];
    this.#backfill = [];
    this.#rows = 0;
    this.#bytes = 0;
    for (const j of jobs) {
      try {
        this.#commit(j.batch);
        j.resolve();
      } catch (e) {
        j.reject(e);
      }
    }
  }
}
