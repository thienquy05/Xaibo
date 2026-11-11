// Single-writer batches (P1-T07): records commit together with their source-file checkpoint in one transaction;
// live batches are committed ahead of backfill; flush at the S12 bounds (100 rows, 1 MiB or 50 ms).
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;
const FTS_MAX_BYTES = 64 * 1024;

export interface SourceFileCheckpoint {
  path: string; kind: string; dev: number; ino: number; size: number; mtime: number; offset: number; headHash: string;
  status: 'ok' | 'compressed_not_imported' | 'gone' | 'oversized';
}
export interface SessionUpsert {
  nativeSessionId: string; cwd?: string; cwdKey?: string; entrypoint?: string; interactive?: boolean; title?: string;
  startedAt?: number; lastActivity?: number;
}
export interface EventRow {
  nativeSessionId: string; source: string; confidence: string; nativeId: string; parentNativeId?: string; messageId?: string;
  kind: string; role?: string; subagentNativeId?: string; byteOffset?: number; sourceSeq: number; sourceTs?: number;
  fileMtime?: number; receivedTs: number; ingestId?: string; injected?: boolean; content?: string; raw?: string;
}
export interface QuarantineRow { nativeSessionId?: string; byteOffset: number; reason: string; raw?: Uint8Array; receivedTs: number }
export interface SubagentLink { nativeSessionId: string; nativeId: string; agentType?: string }
export interface Batch {
  profileId: string; agent: string; file: SourceFileCheckpoint; fileSession?: string;
  sessions: SessionUpsert[]; events: EventRow[]; quarantine?: QuarantineRow[]; subagents?: SubagentLink[];
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

// Prepared once per connection (§7.4 cached prepared statements).
const cache = new WeakMap<DatabaseSync, ReturnType<typeof prepare>>();
const statements = (db: DatabaseSync) => cache.get(db) ?? cache.set(db, prepare(db)).get(db)!;

function prepare(db: DatabaseSync) {
  return {
    upsertSession: db.prepare(`INSERT INTO sessions (agent, profile_id, native_session_id, cwd, cwd_key, entrypoint, interactive, title, started_at, last_activity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent, profile_id, native_session_id) DO UPDATE SET
        cwd = coalesce(sessions.cwd, excluded.cwd), cwd_key = coalesce(sessions.cwd_key, excluded.cwd_key),
        entrypoint = coalesce(sessions.entrypoint, excluded.entrypoint), interactive = coalesce(sessions.interactive, excluded.interactive),
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
    counts: db.prepare(`UPDATE sessions SET record_count = record_count + ?, unknown_count = unknown_count + ?,
      quarantined_count = quarantined_count + ? WHERE id = ?`),
    quarantine: db.prepare(`INSERT INTO quarantine (file_id, byte_offset, reason, raw, received_ts) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (file_id, byte_offset) DO NOTHING RETURNING id`),
    link: db.prepare('INSERT INTO subagents (session_id, native_id, file_id, agent_type) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'),
    drift: db.prepare('UPDATE sessions SET drift = (unknown_count * 20 > record_count) WHERE id = ?'), // EC-04: unknown share > 5%
  };
}

export function commitBatch(db: DatabaseSync, batch: Batch): void {
  const st = statements(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const ids = new Map<string, number | bigint>();
    for (const s of batch.sessions) {
      const row = st.upsertSession.get(batch.agent, batch.profileId, s.nativeSessionId, s.cwd ?? null, s.cwdKey ?? null, s.entrypoint ?? null,
        b(s.interactive), s.title ?? null, s.startedAt ?? null, s.lastActivity ?? null) as { id: number };
      ids.set(s.nativeSessionId, row.id);
    }
    const sessionId = (nativeId: string) => {
      const id = ids.get(nativeId);
      if (id === undefined) throw new Error('event for a session missing from its batch');
      return id;
    };

    const f = batch.file;
    const file = st.upsertFile.get(batch.profileId, batch.fileSession ? sessionId(batch.fileSession) : null, f.path, f.kind, f.dev, f.ino,
      f.size, f.mtime, f.offset, f.headHash, f.status) as { id: number };

    const added = new Map<number | bigint, [number, number, number]>();
    const bump = (id: number | bigint, i: 0 | 1 | 2) => { const c = added.get(id) ?? [0, 0, 0]; c[i]++; added.set(id, c); };

    for (const e of batch.events) {
      const sid = sessionId(e.nativeSessionId);
      const row = st.insertEvent.get(sid, SCHEMA_VERSION, e.source, e.confidence, e.nativeId, e.parentNativeId ?? null, e.messageId ?? null,
        e.kind, e.role ?? null, e.subagentNativeId ?? null, file.id, e.byteOffset ?? null, e.sourceSeq, e.sourceTs ?? null,
        e.fileMtime ?? null, e.receivedTs, e.ingestId ?? null, e.injected ? 1 : 0, e.content ?? null, e.raw ?? null) as { id: number } | undefined;
      if (!row) continue; // already stored (reparse after truncation or rotation)
      if (e.content) st.insertFts.run(row.id, ftsPrefix(e.content));
      if (e.kind.endsWith('-chunk')) continue; // storage of an oversized record (EC-15), not a record: keeps EC-04's ratio
      bump(sid, 0);
      if (e.kind === 'unknown') bump(sid, 1);
    }

    for (const q of batch.quarantine ?? []) {
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
    db.exec('ROLLBACK');
    throw e;
  }
}

interface Pending { batch: Batch; resolve: () => void; reject: (e: unknown) => void }
export interface WriterOptions {
  maxRows?: number; maxBytes?: number; maxDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => void;
  onCommit?: (batch: Batch) => void;
}

const batchBytes = (b: Batch) => b.events.reduce((n, e) => n + (e.content?.length ?? 0) + (e.raw?.length ?? 0), 0);

/** Queues batches; live work is committed before backfill. Each batch is its own transaction. */
export class Writer {
  readonly #db: DatabaseSync;
  readonly #o: Required<Omit<WriterOptions, 'onCommit'>> & Pick<WriterOptions, 'onCommit'>;
  #live: Pending[] = [];
  #backfill: Pending[] = [];
  #rows = 0;
  #bytes = 0;
  #timerSet = false;

  constructor(db: DatabaseSync, o: WriterOptions = {}) {
    this.#db = db;
    this.#o = { maxRows: 100, maxBytes: 1 << 20, maxDelayMs: 50, setTimer: (fn, ms) => void setTimeout(fn, ms), ...o };
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
        commitBatch(this.#db, j.batch);
        this.#o.onCommit?.(j.batch);
        j.resolve();
      } catch (e) {
        j.reject(e);
      }
    }
  }
}
