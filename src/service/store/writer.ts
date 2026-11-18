// Single-writer batches (P1-T07): records commit together with their source-file checkpoint in one transaction;
// live batches are committed ahead of backfill; flush at the S12 bounds (100 rows, 1 MiB or 50 ms).
import type { DatabaseSync } from 'node:sqlite';
import { byRank, mergeToolCalls, type ToolCallObservation } from '../normalize.ts';
import { resolveRepository, type Grouping } from '../history/repository.ts';
import { cwdKey } from '../paths.ts';
import { isDiskFull } from './db.ts';
import { blocks, clear as clearMarker, MARKER, noteFile, refuses, type Marker } from '../history/suppression.ts';
import { agyUsage, claudeUsage, codexRateLimits, codexStep, codexUsage, tokenRecordDrift, type Usage } from '../usage/tokens.ts';
import { contextStep, type ContextObs, type Snapshot } from '../usage/context.ts';
import { codexReadings, historyStep, scopeKey, sourceTime, type Reading, type Stored } from '../usage/snapshots.ts';
import { LAST_RUN_KEY, QUOTA_MS } from '../retention/policy.ts';

export const SCHEMA_VERSION = 1;
// The FTS row of an event is its ftsPrefix; deletes (revisions, purge) must pass that same text, so changing this bound
// leaves rows indexed under the old one undeletable (XAIBO-PROD-515 review M5).
const FTS_MAX_BYTES = 64 * 1024;
/** P4-T08: model evidence relayed by Xaibo's own channels (not the agent's file) and the effort fill window. */
const RELAYED = new Set(['hook', 'report', 'statusline']);
const FILL_MS = 60_000;

export interface SourceFileCheckpoint {
  path: string; kind: string; dev: number; ino: number; size: number; mtime: number; offset: number; headHash: string;
  status: 'ok' | 'compressed_not_imported' | 'gone' | 'oversized';
  /** P5-T08: the stored epoch this checkpoint was read at; a re-import reset since then wins. Absent = unguarded. */
  epoch?: number;
}
export interface SessionUpsert {
  nativeSessionId: string; cwd?: string; cwdKey?: string; entrypoint?: string; interactive?: boolean;
  /** The native title: Claude's rename (custom-title); aiTitle is Claude's generated title, kept apart (XAIBO-PROD-507). */
  title?: string; aiTitle?: string;
  /** XAIBO-PROD-508: only sets the title of an already stored session (Codex thread names); never inserts one. */
  existing?: boolean;
  startedAt?: number; lastActivity?: number; originator?: string; nativeArchived?: boolean;
  /** P2-T11 (EC-81): false once the native conversation is verifiably gone; true again when it reappears. */
  nativeAvailable?: boolean;
  /** Every distinct cwd the batch saw (P2-T05, EC-06): cwd_history rows, never a second session. */
  cwds?: CwdSeen[];
  /** P3-T15: the Codex account marker (salted HMAC, never the raw id); the first one stored is kept. */
  accountEpoch?: string;
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
  /** P2-T08: model evidence (effort undefined = not exposed); `turn` names the turn it belongs to when the record says;
   *  `ts` orders it when the event has no source time (P4-T08: statusLine tee, service clock); `stale` (XAIBO-PROD-442):
   *  older than evidence already stored from the same producer, so it only fills its own turn. */
  model?: { id: string; effort?: string | null; turn?: string; ts?: number; stale?: true };
  /** P2-T07: a context observation; a Codex one with model null takes the session's current model at write time. */
  context?: ContextObs;
  /** P2-T11 (EC-80, agy): apply in source order by sourceSeq: current rows of the session with seq >= this one become
   *  superseded (same seq) or rewound (higher), and this row is current again if it was stored before. */
  revise?: boolean;
  /** P3-T15: quota readings this record carries (Claude statusLine tee); Codex readings come from `usage`. */
  quota?: Reading[];
  /** P3-T15 (§5.12): the agent-reported session cost (statusLine `cost.total_cost_usd`). */
  reportedCost?: number;
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
  /** P3-T13b2: the profile a custom agent's registration creates with this batch (never replaces an existing one). */
  profile?: { id: string; agent: string; root: string; origin: 'registration' };
}
export interface ReportDelivery {
  registrationId: string; deliveryId: string; agent: string; profileKey: string; nativeSessionId: string; event: string;
  producerId: string; producerSeq: number; receivedTs: number; committedTs: number; unattributed: 'unknown-profile' | null;
  /** XAIBO-PROD-453: the delivery committed model evidence (only these make a lower producer_seq model frame stale). */
  hasModel?: boolean;
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
        originator, native_archived, native_available, account_epoch, repo_key, worktree, repo_reason, ai_title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, 1), ?, ?, ?, ?, ?)
      ON CONFLICT (agent, profile_id, native_session_id) DO UPDATE SET
        repo_key = CASE WHEN sessions.cwd IS NULL THEN excluded.repo_key ELSE sessions.repo_key END,
        worktree = CASE WHEN sessions.cwd IS NULL THEN excluded.worktree ELSE sessions.worktree END,
        repo_reason = CASE WHEN sessions.cwd IS NULL THEN excluded.repo_reason ELSE sessions.repo_reason END,
        account_epoch = coalesce(sessions.account_epoch, excluded.account_epoch),
        cwd = coalesce(sessions.cwd, excluded.cwd), cwd_key = coalesce(sessions.cwd_key, excluded.cwd_key),
        entrypoint = coalesce(sessions.entrypoint, excluded.entrypoint), interactive = coalesce(sessions.interactive, excluded.interactive),
        originator = coalesce(sessions.originator, excluded.originator), native_archived = max(sessions.native_archived, excluded.native_archived),
        native_available = coalesce(?, sessions.native_available),
        title = coalesce(excluded.title, sessions.title), ai_title = coalesce(excluded.ai_title, sessions.ai_title),
        started_at = min(coalesce(sessions.started_at, excluded.started_at), coalesce(excluded.started_at, sessions.started_at)),
        last_activity = max(coalesce(sessions.last_activity, excluded.last_activity), coalesce(excluded.last_activity, sessions.last_activity))
      RETURNING id`),
    setTitle: db.prepare('UPDATE sessions SET title = ? WHERE agent = ? AND profile_id = ? AND native_session_id = ? AND title IS NOT ?'),
    // P5-T08 (review H2): a checkpoint read before a re-import reset (older epoch) never moves the reset one; no epoch = unguarded
    upsertFile: db.prepare(`INSERT INTO source_files (profile_id, session_id, path, kind, dev, ino, size, mtime, offset, head_hash, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET session_id = coalesce(excluded.session_id, source_files.session_id), kind = excluded.kind,
        dev = excluded.dev, ino = excluded.ino, size = excluded.size, mtime = excluded.mtime, offset = excluded.offset,
        head_hash = excluded.head_hash, status = excluded.status
      WHERE ? IS NULL OR source_files.epoch = ?
      RETURNING id`),
    insertEvent: db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, parent_native_id, message_id,
        kind, role, subagent_native_id, file_id, byte_offset, source_seq, source_ts, file_mtime, received_ts, ingest_id, injected, content, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, source, native_id) DO NOTHING RETURNING id`),
    insertFts: db.prepare('INSERT INTO event_fts (rowid, content) VALUES (?, ?)'),
    delivery: db.prepare(`INSERT INTO hook_delivery (delivery_id, agent, profile_key, native_session_id, event, received_ts, committed_ts, unattributed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`),
    report: db.prepare(`INSERT INTO report_delivery (registration_id, delivery_id, agent, profile_key, native_session_id, event, producer_id, producer_seq,
        received_ts, committed_ts, unattributed, has_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING delivery_id`),
    newProfile: db.prepare('INSERT INTO profiles (id, agent, root, origin) VALUES (?, ?, ?, ?)'), // a conflict fails the commit, never skips
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
      ON CONFLICT (session_id, native_turn_id) DO UPDATE SET -- P4-T08 review L5: the earliest start of any source
        started_at = min(coalesce(turns.started_at, excluded.started_at), coalesce(excluded.started_at, turns.started_at)),
        ended_at = coalesce(turns.ended_at, excluded.ended_at), outcome = coalesce(turns.outcome, excluded.outcome)`),
    // P4-T08: ?1 = effort exposed. Unexposed effort keeps the same model's recorded effort; another model gets none.
    currentModel: db.prepare(`UPDATE sessions SET current_effort = CASE WHEN ?1 THEN ?2 WHEN current_model IS ?3 THEN current_effort END,
      current_model = ?3, current_model_ts = ?4 WHERE id = ?5 AND (current_model_ts IS NULL OR current_model_ts <= ?4)`),
    // Older exposed evidence fills a missing effort of the same model only within FILL_MS of the current model's time
    // (a hook stamped just after the file record that names the effort; review M2).
    // ponytail: no switch history or explicit-null marker is stored, so within 60 s a late effort can fill one a newer
    // record set to null, or one from before an A -> B -> A switch back; store a per-model "since" if that shows up.
    fillEffort: db.prepare(`UPDATE sessions SET current_effort = ?1 WHERE id = ?2 AND current_model = ?3 AND current_effort IS NULL
      AND (current_model_ts IS NULL OR current_model_ts - ?4 <= ${FILL_MS})`),
    firstModel: db.prepare('UPDATE sessions SET current_model = ?, current_effort = ? WHERE id = ? AND current_model IS NULL'),
    turnModel: db.prepare(`INSERT INTO turns (session_id, schema_version, source, native_turn_id, model_id, effort) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT (session_id, native_turn_id) DO UPDATE SET model_id = excluded.model_id,
        effort = CASE WHEN ?7 THEN excluded.effort WHEN turns.model_id IS excluded.model_id THEN turns.effort END`),
    // Review M3: hook, report and statusLine evidence only fills a turn's model; the agent's own file stays authoritative.
    turnModelFill: db.prepare(`INSERT INTO turns (session_id, schema_version, source, native_turn_id, model_id, effort) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT (session_id, native_turn_id) DO UPDATE SET model_id = coalesce(turns.model_id, excluded.model_id),
        effort = CASE WHEN ?7 AND (turns.model_id IS NULL OR turns.model_id = excluded.model_id) THEN excluded.effort ELSE turns.effort END`),
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
    sessionEpoch: db.prepare('SELECT account_epoch FROM sessions WHERE id = ?'),
    scope: db.prepare(`INSERT INTO usage_scopes (scope_key, profile_id, agent, epoch, session_id, verified) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key) DO UPDATE SET scope_key = excluded.scope_key RETURNING id`),
    prevHistory: db.prepare(`SELECT used_percent, window_minutes, resets_at, plan, credits, as_of, first_observed_at, measured_at FROM usage_history
      WHERE usage_scope_id = ? AND limit_id = ? AND measured_at <= ? ORDER BY measured_at DESC, id DESC LIMIT 1`),
    putHistory: db.prepare(`INSERT INTO usage_history (schema_version, usage_scope_id, limit_id, kind, minute, used_percent, window_minutes, resets_at,
        plan, credits, as_of, first_observed_at, observed_at, measured_at, source, source_locator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (usage_scope_id, limit_id, kind, minute) DO UPDATE SET used_percent = excluded.used_percent, window_minutes = excluded.window_minutes,
        resets_at = excluded.resets_at, plan = excluded.plan, credits = excluded.credits, as_of = excluded.as_of,
        first_observed_at = excluded.first_observed_at, observed_at = excluded.observed_at, measured_at = excluded.measured_at,
        source = excluded.source, source_locator = excluded.source_locator
      WHERE excluded.measured_at >= usage_history.measured_at`),
    nextHistory: db.prepare(`SELECT id, kind, window_minutes, resets_at, plan, measured_at FROM usage_history
      WHERE usage_scope_id = ? AND limit_id = ? AND measured_at > ? ORDER BY measured_at, id LIMIT 1`),
    beforeHistory: db.prepare(`SELECT window_minutes, resets_at, plan FROM usage_history
      WHERE usage_scope_id = ? AND limit_id = ? AND measured_at < ? ORDER BY measured_at DESC, id DESC LIMIT 1`),
    // a clash with a row of that kind in the same minute keeps the old kind (the one-per-minute cap wins)
    setKind: db.prepare('UPDATE OR IGNORE usage_history SET kind = ? WHERE id = ?'),
    kv: db.prepare('SELECT value FROM kv WHERE key = ?'),
    reportedCost: db.prepare(`INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd, basis, coverage)
      VALUES (?, ?, ?, 'session:statusline', ?, 'agent_reported', '{"coverage":"full"}')
      ON CONFLICT (session_id, covered_scope) DO UPDATE SET amount_usd = excluded.amount_usd`),
    marker: db.prepare(MARKER),
    fileId: db.prepare('SELECT id FROM source_files WHERE path = ?'),
  };
}

/** XAIBO-PROD-515/516 (FR-11, EC-21/22, review M1): the batch without the sessions its markers keep out (suppression.ts
 *  blocks): their events, subagent links and quarantine rows go too, and a dropped file session leaves the file's
 *  checkpoint unattached (its quarantine dropped), so the checkpoint still advances and the other sessions of the file
 *  still commit. `clear`: retention markers this batch's new native activity clears (re-import). */
function unsuppressed(st: ReturnType<typeof prepare>, batch: Batch): { batch: Batch; gone: Set<string>; clear: Set<string> } {
  const ids = new Set([...batch.sessions.map((s) => s.nativeSessionId), ...(batch.fileSession !== undefined ? [batch.fileSession] : [])]);
  const gone = new Set<string>(), clear = new Set<string>();
  for (const id of ids) {
    const m = st.marker.get(batch.agent, batch.profileId, id) as Marker | undefined;
    if (!m || m.cleared_at !== null) continue;
    const fresh = batch.events.some((e) => e.nativeSessionId === id && e.sourceTs !== undefined && e.sourceTs > m.at && (e.fileMtime === undefined || e.fileMtime > m.at));
    (blocks(m, fresh) ? gone : clear).add(id);
  }
  if (!gone.size) return { batch, gone, clear };
  const { fileSession, quarantine, subagents, ...rest } = batch;
  const fileGone = fileSession !== undefined && gone.has(fileSession);
  return { gone, clear, batch: {
    ...rest, sessions: batch.sessions.filter((s) => !gone.has(s.nativeSessionId)), events: batch.events.filter((e) => !gone.has(e.nativeSessionId)),
    ...(fileSession !== undefined && !fileGone ? { fileSession } : {}),
    ...(quarantine ? { quarantine: fileGone ? [] : quarantine.filter((q) => q.nativeSessionId === undefined || !gone.has(q.nativeSessionId)) } : {}),
    ...(subagents ? { subagents: subagents.filter((s) => !gone.has(s.nativeSessionId)) } : {}),
  } };
}

/** Research L6: rolls back after a failure without replacing the caller's error (a throwing ROLLBACK is swallowed).
 *  True when the connection is still inside a transaction afterwards. */
export function rollback(db: DatabaseSync): boolean {
  try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* the original error is the one reported */ }
  return db.isTransaction;
}

type HistRow = { used_percent: number | null; window_minutes: number | null; resets_at: number | null; plan: string | null; credits: string | null;
  as_of: number | null; first_observed_at: number; measured_at: number };
/** P3-T15 (§5.11, EC-91, EC-92): readings of one newly stored event into its usage scope's minute history. The scope is
 *  the Codex account marker when the session has one, else the session itself (account unverified). */
function history(st: ReturnType<typeof prepare>, batch: Batch, sid: number | bigint, e: EventRow, readings: Reading[]) {
  if (!readings.length) return;
  const epoch = batch.agent === 'codex' ? (st.sessionEpoch.get(sid) as { account_epoch: string | null } | undefined)?.account_epoch ?? null : null;
  const k = scopeKey({ profileId: batch.profileId, agent: batch.agent, epoch, nativeSessionId: e.nativeSessionId });
  const scope = (st.scope.get(k.key, batch.profileId, batch.agent, k.epoch, k.verified ? null : sid, k.verified ? 1 : 0) as { id: number }).id;
  // P5-T11 (EC-99): an account-level reading the last retention run already expired is never stored again (a re-import or
  // rescan of an old rollout); NaN (no run yet) keeps everything. Session-linked readings follow their session instead.
  // Review M3: a last run later than the wall clock (stored while the clock was set ahead) is ignored, so new readings
  // are never refused for the time it would take the corrected clock to catch up.
  const lastRun = k.verified ? Number((st.kv.get(LAST_RUN_KEY) as { value: string } | undefined)?.value) : NaN;
  const expiredUpTo = lastRun <= Date.now() ? lastRun - QUOTA_MS : NaN;
  for (const r of readings) {
    const p = st.prevHistory.get(scope, r.stream, sourceTime(r, e.receivedTs) ?? e.receivedTs) as HistRow | undefined;
    const prev: Stored | null = p ? { stream: r.stream, usedPercent: p.used_percent, windowMinutes: p.window_minutes, resetsAt: p.resets_at, plan: p.plan,
      credits: p.credits, asOf: p.as_of, firstObservedAt: p.first_observed_at, measuredAt: p.measured_at } : null;
    const step = historyStep(prev, r, e.receivedTs);
    if (step.action === 'skip' || step.measuredAt <= expiredUpTo) continue;
    st.putHistory.run(SCHEMA_VERSION, scope, r.stream, step.action, step.minute, r.usedPercent, r.windowMinutes, r.resetsAt, r.plan, r.credits,
      sourceTime(r, e.receivedTs), step.firstObservedAt, e.receivedTs, step.measuredAt, e.source, e.nativeId);
    // Review M1: a backfilled older reading can change what the next row follows; reclassify it against its predecessor.
    type K = { window_minutes: number | null; resets_at: number | null; plan: string | null };
    const next = st.nextHistory.get(scope, r.stream, step.measuredAt) as (K & { id: number; kind: string; measured_at: number }) | undefined;
    if (!next) continue;
    const before = st.beforeHistory.get(scope, r.stream, next.measured_at) as K | undefined;
    const kind = before && (before.resets_at !== next.resets_at || before.window_minutes !== next.window_minutes || before.plan !== next.plan) ? 'transition' : 'sample';
    if (kind !== next.kind) st.setKind.run(kind, next.id);
  }
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
      history(st, batch, sid, e, codexReadings(u.rateLimits, e.sourceTs ?? null));
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

// XAIBO-PROD-506 (P5-T01b; FR-53): a session's repository grouping is resolved from its cwd before the transaction and
// stored only with the cwd's first value (the upsert's CASE), so it is set once and never regrouped (Q24, EC-108).
// ponytail: memoized per cwd for the process lifetime (capped, cleared when full; an unreadable answer is not kept, so a
// mount that was not ready is tried again); a directory that becomes a repository later is seen as one after a restart.
// Resolution is sync file metadata I/O on the writer path: a hung network mount above a cwd would stall the writer;
// move it to a worker if that is ever seen.
const GROUP_MEMO_MAX = 512;
const groupMemo = new Map<string, Grouping>();
function groupingOf(cwd: string): Grouping {
  let g = groupMemo.get(cwd);
  if (!g) {
    if (groupMemo.size >= GROUP_MEMO_MAX) groupMemo.clear();
    g = resolveRepository(cwd);
    if (!(g.kind === 'cwd' && g.reason === 'unreadable')) groupMemo.set(cwd, g); // overlong cwds are unreadable: never kept
  }
  return g;
}

/** Commits one batch; returns what it committed (the batch without suppressed sessions, P5-T07). */
export function commitBatch(db: DatabaseSync, input: Batch): Batch {
  const st = statements(db);
  const groups = new Map(input.sessions.map((s) => [s, s.cwd ? groupingOf(s.cwd) : null])); // file metadata reads, outside the transaction
  db.exec('BEGIN IMMEDIATE');
  try {
    // read inside the transaction (keeps the session objects): a purge committed meanwhile is seen
    const { batch, gone, clear } = unsuppressed(st, input);
    const d = batch.delivery, r = batch.report;
    // review: a delivery intake would refuse (a suppressed session, or one timed before its purge) commits nothing, not even its dedup row
    const refused = (agent: string, profile: string, native: string, ts: number) => refuses(st.marker.get(agent, profile, native) as Marker | undefined, ts);
    if ((d?.nativeSessionId && refused(d.agent, d.profileKey, d.nativeSessionId, Math.min(d.receivedTs, d.committedTs)))
      || (r && refused(r.agent, r.profileKey, r.nativeSessionId, r.receivedTs))) {
      db.exec('COMMIT');
      return batch;
    }
    if (d && !st.delivery.get(d.deliveryId, d.agent, d.profileKey, d.nativeSessionId, d.event, d.receivedTs, d.committedTs, d.unattributed)) {
      db.exec('COMMIT'); // already stored (spool replay of an acked delivery, or a retry)
      return batch;
    }
    if (r) {
      if (!st.report.get(r.registrationId, r.deliveryId, r.agent, r.profileKey, r.nativeSessionId, r.event, r.producerId, r.producerSeq, r.receivedTs,
        r.committedTs, r.unattributed, r.hasModel ? 1 : 0)) { db.exec('COMMIT'); return batch; }
      const c = r.content;
      if (c) st.reportContent.run(r.registrationId, r.nativeSessionId, c.itemId, c.revision, c.role, c.kind, c.state, c.chunks, c.bytes, c.text, r.committedTs);
    }
    const np = batch.profile;
    if (np) st.newProfile.run(np.id, np.agent, np.root, np.origin);
    const ids = new Map<string, number | bigint>();
    for (const s of batch.sessions) {
      if (s.existing) { if (s.title) st.setTitle.run(s.title, batch.agent, batch.profileId, s.nativeSessionId, s.title); continue; }
      const g = groups.get(s) ?? null;
      const row = st.upsertSession.get(batch.agent, batch.profileId, s.nativeSessionId, s.cwd ?? null, s.cwdKey ?? null, s.entrypoint ?? null,
        b(s.interactive), s.title ?? null, s.startedAt ?? null, s.lastActivity ?? null, s.originator ?? null, s.nativeArchived ? 1 : 0,
        b(s.nativeAvailable), s.accountEpoch ?? null, g?.kind === 'repository' ? g.key : null, g?.kind === 'repository' ? g.worktree : null,
        g?.kind === 'cwd' ? g.reason : null, s.aiTitle ?? null, b(s.nativeAvailable)) as { id: number };
      ids.set(s.nativeSessionId, row.id);
      for (const c of s.cwds ?? []) st.cwd.run(row.id, SCHEMA_VERSION, c.source, c.cwd, c.cwdKey, c.firstSeen ?? null);
    }
    const sessionId = (nativeId: string) => {
      const id = ids.get(nativeId);
      if (id === undefined) throw new Error('event for a session missing from its batch');
      return id;
    };

    const f = batch.file;
    const file = f ? (st.upsertFile.get(batch.profileId, batch.fileSession ? sessionId(batch.fileSession) : null, f.path, f.kind, f.dev, f.ino,
      f.size, f.mtime, f.offset, f.headHash, f.status, f.epoch ?? null, f.epoch ?? null) ?? st.fileId.get(f.path)) as { id: number } : { id: null };
    // P5-T08: re-import bookkeeping after this batch's own checkpoint. A file that held records of a session kept out joins
    // its marker (review M2); a retention marker cleared by new activity resets its files for a whole re-import.
    const who = (native: string) => ({ agent: batch.agent, profile: batch.profileId, native });
    if (file.id !== null) {
      for (const id of gone) if (input.fileSession === id || input.events.some((e) => e.nativeSessionId === id)) noteFile(db, who(id), file.id);
    }
    for (const id of clear) clearMarker(db, who(id), Math.max(...batch.events.filter((e) => e.nativeSessionId === id).map((e) => e.receivedTs)));

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
        const effort = e.model.effort ?? null, exposed = e.model.effort !== undefined ? 1 : 0;
        const ts = e.model.ts ?? e.sourceTs, fresh = !e.model.stale;
        if (fresh && ts !== undefined) st.currentModel.run(exposed, effort, e.model.id, ts, sid);
        else st.firstModel.run(e.model.id, effort, sid); // only fills an unknown model, never replaces one (stale too: review L2)
        if (fresh && effort !== null) st.fillEffort.run(effort, sid, e.model.id, ts ?? null); // older evidence still names the effort it only now knows
        if (e.model.turn) (RELAYED.has(e.source) ? st.turnModelFill : st.turnModel).run(sid, SCHEMA_VERSION, e.source, e.model.turn, e.model.id, effort, exposed);
        else if (fresh && ts !== undefined) st.latestTurnModel.run(e.model.id, effort, sid, ts);
      }
      if (e.context) context(st, sid, e, e.context);
      if (e.quota) history(st, batch, sid, e, e.quota);
      if (e.reportedCost !== undefined) st.reportedCost.run(sid, SCHEMA_VERSION, e.source, e.reportedCost);
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
    return batch;
  } catch (e) {
    rollback(db); // SQLite already rolled back on SQLITE_FULL; keep that error, not ours
    throw e;
  }
}


interface Pending { batch: Batch; resolve: () => void; reject: (e: unknown) => void }
export interface WriterOptions {
  maxRows?: number; maxBytes?: number; maxDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => void;
  /** Clock for the queue-age metric (P4-T10c2). */
  now?: () => number;
  onCommit?: (batch: Batch) => void;
  /** EC-44: called when the store becomes full and again when a commit succeeds after that, outside any transaction. */
  onDiskFull?: (full: boolean) => void;
  /** Fault injection for tests (Q3-15); commitBatch otherwise. Returns what it committed (void = the batch as given). */
  commit?: (db: DatabaseSync, batch: Batch) => Batch | void;
}

const batchBytes = (b: Batch) => b.events.reduce((n, e) => n + (e.content?.length ?? 0) + (e.raw?.length ?? 0), 0);

/** Queues batches; live work is committed before backfill. Each batch is its own transaction. */
export class Writer {
  readonly #db: DatabaseSync;
  readonly #o: Required<Omit<WriterOptions, 'onCommit' | 'onDiskFull'>> & Pick<WriterOptions, 'onCommit' | 'onDiskFull'>;
  #full = false;
  #broken = false;
  #live: Pending[] = [];
  #backfill: Pending[] = [];
  #rows = 0;
  #bytes = 0;
  #timerSet = false;
  /** P4-T10c2: when the oldest queued batch was enqueued, and the peak enqueue-to-flush wait since the last take. */
  #since: number | undefined;
  #peak = 0;

  constructor(db: DatabaseSync, o: WriterOptions = {}) {
    this.#db = db;
    this.#o = { maxRows: 100, maxBytes: 1 << 20, maxDelayMs: 50, setTimer: (fn, ms) => void setTimeout(fn, ms), commit: commitBatch, now: () => performance.now(), ...o }; // monotonic: a wall-clock step is no queue age
  }

  /** The peak queue age (ms) since the previous call; resets it. A live commit bypasses the queue and adds nothing. */
  takeQueueAgeMs(): number { const p = this.#peak; this.#peak = 0; return p; }

  /** True from a disk-full commit until the next commit succeeds (EC-44). */
  get diskFull(): boolean { return this.#full; }

  /** A live hook delivery (OQ-A1): its own small transaction now, ahead of anything queued; throws on failure. */
  commitLive(batch: Batch): Batch {
    return this.#commit(batch);
  }

  /** Returns what was committed (P5-T07/T08: without the sessions a suppression marker kept out). */
  #commit(batch: Batch): Batch {
    // ponytail: while full every commit still runs as the probe (SQLite fails fast without growing); a pause timer if
    // the retried file reads ever cost too much.
    const done = this.#guard(() => this.#o.commit(this.#db, batch)) ?? batch;
    this.#o.onCommit?.(done); // never a suppressed session
    return done;
  }

  /** XAIBO-PROD-515 (P5-T07, research L6): `fn` in one immediate transaction on the writer's connection, with the same
   *  disk-full state as batches (purge, retention). Any throw rolls back and is rethrown as it was; the work is committed
   *  only when this returns. */
  transact<T>(fn: (db: DatabaseSync) => T): T {
    return this.#guard(() => {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn(this.#db);
        this.#db.exec('COMMIT');
        return r;
      } catch (e) {
        rollback(this.#db);
        throw e;
      }
    });
  }

  #guard<T>(run: () => T): T {
    // ponytail: a connection left inside a transaction (a ROLLBACK that failed) is not reused; writes fail until the
    // service restarts and opens a new one. Reopen in place if that is ever seen.
    if (this.#broken) throw new Error('store connection left inside a transaction; restart required');
    let r: T;
    try {
      r = run();
    } catch (e) {
      if (this.#db.isTransaction) this.#broken = true;
      if (isDiskFull(e) && !this.#full) { this.#full = true; this.#o.onDiskFull?.(true); }
      throw e;
    }
    if (this.#full) { this.#full = false; this.#o.onDiskFull?.(false); }
    return r;
  }

  enqueue(batch: Batch, live: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      (live ? this.#live : this.#backfill).push({ batch, resolve, reject });
      this.#since ??= this.#o.now();
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
    if (this.#since !== undefined) { this.#peak = Math.max(this.#peak, Math.round(this.#o.now() - this.#since)); this.#since = undefined; }
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
