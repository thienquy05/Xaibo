// Claude adapter (P1-T10): backfill newest-first (live files ahead), then tail via the watcher. Each file is
// synced from its stored checkpoint; records and the new checkpoint commit together (writer.ts).
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { LineSplitter, type Line } from '../../lines.ts';
import { cwdKey } from '../../paths.ts';
import type { Batch, EventRow, QuarantineRow, SessionUpsert, SourceFileCheckpoint, Writer } from '../../store/writer.ts';
import { headHash, HEAD_BYTES, readRange, readZstd, startOffset, zstdAvailable, type Checkpoint } from '../../tail.ts';
import { Watcher, type WatchFn } from '../../watch.ts';
import { discover, type ClaudeFile } from './discover.ts';
import { OversizedRecord } from './oversized.ts';
import { parseLine, type ClaudeRecord } from './parse.ts';

export interface ClaudeAdapterOptions {
  db: DatabaseSync;
  writer: Writer;
  profileId: string;
  root: string;
  zstd?: boolean;
  intervalMs?: number;
  activeMs?: number;
  eventsPerBatch?: number; // S12 bounds: 100 rows / 1 MiB per transaction
  bytesPerBatch?: number;
  chunkBytes?: number;
  maxLineBytes?: number; // parse cap (OQ-P1-06): longer lines stream through oversized.ts
  watch?: WatchFn;
  now?: () => number;
}

type Stored = Checkpoint & { status: SourceFileCheckpoint['status'] };

// In-memory parse cap (D-P1-13, OQ-P1-06 measured): an in-memory line costs about 7x its size in the service (bytes,
// raw and parsed strings, SQLite binds and record build), so 64 MiB could not meet the EC-15 RSS bound; longer lines
// take the bounded streaming path (oversized.ts).
export const PARSE_CAP = 8 * 1024 * 1024;

export class ClaudeAdapter {
  readonly #o: Required<Omit<ClaudeAdapterOptions, 'watch'>> & Pick<ClaudeAdapterOptions, 'watch'>;
  readonly #watcher: Watcher<ClaudeFile>;
  readonly #chains = new Map<string, Promise<void>>(); // one sync at a time per file
  readonly #reads = new Map<string, number>();

  constructor(o: ClaudeAdapterOptions) {
    this.#o = { zstd: zstdAvailable, intervalMs: 5000, activeMs: 10 * 60_000, eventsPerBatch: 100, bytesPerBatch: 1 << 20, chunkBytes: 1 << 20, maxLineBytes: PARSE_CAP, now: Date.now, ...o };
    this.#watcher = new Watcher<ClaudeFile>({
      list: () => discover(this.#o.root),
      onChange: (f) => void this.sync(f, true).catch(() => undefined), // a failed sync is retried on the next change or scan
      intervalMs: this.#o.intervalMs, activeMs: this.#o.activeMs, now: this.#o.now,
      ...(this.#o.watch ? { watch: this.#o.watch } : {}),
    });
  }

  /** Times a file was opened for reading (EC-19: unchanged files are never read). */
  reads(path: string): number { return this.#reads.get(path) ?? 0; }

  async start(): Promise<void> {
    await this.#watcher.start(); // snapshot first, so changes during backfill are seen by the next scan
    const files = await discover(this.#o.root);
    const withTime = await Promise.all(files.map(async (f) => ({ f, mtime: (await stat(f.path).catch(() => undefined))?.mtimeMs ?? 0 })));
    withTime.sort((a, b) => b.mtime - a.mtime); // newest first
    const now = this.#o.now();
    const ordered = [...withTime.filter((x) => now - x.mtime < this.#o.activeMs), ...withTime.filter((x) => now - x.mtime >= this.#o.activeMs)];
    for (const x of ordered) { // one file at a time, live files first, newest first
      try { await this.sync(x.f, now - x.mtime < this.#o.activeMs); } catch { /* retried on the next change or scan */ }
    }
  }

  stop(): void { this.#watcher.stop(); }

  wake(): Promise<void> { return this.#watcher.scan(); }

  sync(file: ClaudeFile, live: boolean): Promise<void> {
    const next = (this.#chains.get(file.path) ?? Promise.resolve()).then(() => this.#sync(file, live));
    // A failed sync (read or commit) makes the watcher forget the file, so the next scan or wake retries it.
    this.#chains.set(file.path, next.catch(() => this.#watcher.forget(file.path)));
    return next;
  }

  #checkpoint(path: string): Stored | undefined {
    const r = this.#o.db.prepare('SELECT dev, ino, size, mtime, offset, head_hash, status FROM source_files WHERE path = ?').get(path) as
      { dev: number; ino: number; size: number; mtime: number; offset: number; head_hash: string; status: Stored['status'] } | undefined;
    return r && { dev: r.dev, ino: r.ino, size: r.size, mtime: r.mtime, offset: r.offset, headHash: r.head_hash, status: r.status };
  }

  async #sync(file: ClaudeFile, live: boolean): Promise<void> {
    let st;
    try { st = await stat(file.path); } catch { return; } // gone between discovery and sync
    const cp = this.#checkpoint(file.path);
    const base = { path: file.path, kind: file.kind, dev: st.dev, ino: st.ino, size: st.size, mtime: st.mtimeMs };
    if (file.compressed) {
      if (cp && cp.dev === st.dev && cp.ino === st.ino && cp.size === st.size && cp.mtime === st.mtimeMs) return;
      if (!this.#o.zstd) {
        await this.#o.writer.enqueue(this.#batch(file, { ...base, offset: 0, headHash: '', status: 'compressed_not_imported' }, [], []), live);
        return;
      }
      this.#count(file.path);
      await this.#ingest(file, readZstd(file.path, this.#o.chunkBytes), 0, base, live, () => '', 'ok');
      return;
    }
    if (cp && cp.dev === st.dev && cp.ino === st.ino && cp.size === st.size && cp.mtime === st.mtimeMs) return; // nothing new
    this.#count(file.path);
    const { offset, reset } = await startOffset(file.path, st, cp);
    let full: string | undefined; // hash of the first HEAD_BYTES once the checkpoint passes them
    const hashAt = async (committed: number) => (committed >= HEAD_BYTES ? (full ??= await headHash(file.path, HEAD_BYTES)) : headHash(file.path, committed));
    const stream = offset < st.size ? readRange(file.path, offset, st.size, this.#o.chunkBytes) : Readable.from([]);
    await this.#ingest(file, stream, offset, base, live, hashAt, cp?.status === 'oversized' && !reset ? 'oversized' : 'ok');
  }

  async #ingest(file: ClaudeFile, stream: Readable, from: number, base: Omit<SourceFileCheckpoint, 'offset' | 'headHash' | 'status'>,
    live: boolean, hashAt: (committed: number) => Promise<string> | string, status: 'ok' | 'oversized'): Promise<void> {
    const splitter = new LineSplitter(from, { maxLine: this.#o.maxLineBytes });
    let big: OversizedRecord | undefined;
    const receivedTs = this.#o.now();
    let records: ClaudeRecord[] = [];
    let quarantine: QuarantineRow[] = [];
    let bytes = 0;
    let lastEnd = from;
    // An intermediate checkpoint records only the bytes examined so far, so a restart after a crash reads the rest;
    // the final one records the whole size seen at stat time (a trailing partial line stays after `offset`). Each
    // batch is awaited: a failed commit throws and stops this file, so no later checkpoint can pass the lost records.
    const flush = async (final = false) => {
      const cp = { ...base, size: final ? base.size : lastEnd, offset: lastEnd, headHash: await hashAt(lastEnd), status };
      const committed = this.#o.writer.enqueue(this.#batch(file, cp, records, quarantine), live);
      records = [];
      quarantine = [];
      bytes = 0;
      if (final) this.#o.writer.flush(); // each batch is its own transaction; no reason to wait for the timer
      await committed;
    };
    const take = (line: Line) => {
      const r = parseLine(line.bytes, { offset: line.offset, fileMtime: base.mtime, receivedTs, subagentNativeId: file.subagentId });
      if (r?.ok) records.push(r.record);
      else if (r) quarantine.push({ nativeSessionId: file.sessionId, byteOffset: line.offset, reason: 'malformed', raw: line.bytes, receivedTs });
      bytes += line.bytes.length;
      lastEnd = line.offset + line.bytes.length + 1;
    };
    const takeBig = (rs: ClaudeRecord[]) => { for (const r of rs) { records.push(r); bytes += (r.content?.length ?? 0) + r.raw.length; } };
    for await (const chunk of stream) {
      for (const p of splitter.pushPieces(chunk as Buffer)) {
        if (!('big' in p)) take(p);
        else if (p.big === 'start') big = new OversizedRecord({ offset: p.offset, source: file.path, fileMtime: base.mtime, receivedTs, subagentNativeId: file.subagentId });
        else if (p.big === 'data') takeBig(big!.feed(p.bytes));
        else { // the oversized line is complete (EC-15): head row last; a gap only for what could not be read
          const r = big!.end();
          takeBig(r.records);
          if (r.unreadable) { quarantine.push({ nativeSessionId: file.sessionId, byteOffset: p.offset, reason: 'oversized-unreadable', receivedTs }); status = 'oversized'; }
          big = undefined;
          lastEnd = p.offset + p.length + 1;
        }
        if (records.length >= this.#o.eventsPerBatch || bytes >= this.#o.bytesPerBatch) await flush();
      }
    }
    lastEnd = splitter.committedOffset; // stops before a trailing partial line (EC-14)
    await flush(true); // always: the last batch stores the final size/mtime, even with no new records
  }

  #batch(file: ClaudeFile, cp: SourceFileCheckpoint, records: ClaudeRecord[], quarantine: QuarantineRow[]): Batch {
    const sessions = new Map<string, SessionUpsert>();
    const session = (sid: string) => sessions.get(sid) ?? sessions.set(sid, { nativeSessionId: sid }).get(sid)!;
    session(file.sessionId);
    const events: EventRow[] = records.map((r) => {
      const sid = r.sessionId ?? file.sessionId;
      const s = session(sid);
      if (r.cwd && !s.cwd) { s.cwd = r.cwd; s.cwdKey = cwdKey(r.cwd); }
      if (r.entrypoint && !s.entrypoint) s.entrypoint = r.entrypoint;
      if (r.sourceTs !== undefined) {
        s.lastActivity = Math.max(s.lastActivity ?? r.sourceTs, r.sourceTs);
        s.startedAt = Math.min(s.startedAt ?? r.sourceTs, r.sourceTs);
      }
      return {
        nativeSessionId: sid, source: 'transcript', confidence: 'confirmed', nativeId: r.nativeId, parentNativeId: r.parentNativeId,
        messageId: r.messageId, kind: r.kind, role: r.role, subagentNativeId: r.subagentNativeId, byteOffset: r.sourceSeq,
        sourceSeq: r.sourceSeq, sourceTs: r.sourceTs, fileMtime: r.fileMtime, receivedTs: r.receivedTs, injected: r.injected,
        content: r.content, raw: r.raw === '' ? undefined : r.raw, ingestId: r.ingestId,
      };
    });
    const own = session(file.sessionId);
    if (records.length && own.lastActivity === undefined) own.lastActivity = cp.mtime; // records but none with a timestamp
    return {
      profileId: this.#o.profileId, agent: 'claude', file: cp, fileSession: file.sessionId, sessions: [...sessions.values()], events, quarantine,
      subagents: file.kind === 'subagent' && file.subagentId ? [{ nativeSessionId: file.sessionId, nativeId: file.subagentId }] : [],
    };
  }

  #count(path: string): void { this.#reads.set(path, (this.#reads.get(path) ?? 0) + 1); }
}
