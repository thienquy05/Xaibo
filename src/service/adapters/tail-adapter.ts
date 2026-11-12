// Shared file-sync engine (P1-T10, moved out of the Claude adapter in P2-T03 for Codex): backfill newest-first (live
// files ahead), then tail via the watcher. Each file is synced from its stored checkpoint; records and the new
// checkpoint commit together (writer.ts). Subclasses supply discovery, line parsing, oversized lines and batches.
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { LineSplitter, type Line } from '../lines.ts';
import type { Batch, QuarantineRow, SourceFileCheckpoint, Writer } from '../store/writer.ts';
import { headHash, HEAD_BYTES, readRange, readZstd, startOffset, zstdAvailable, type Checkpoint } from '../tail.ts';
import { Watcher, type WatchFn } from '../watch.ts';

export interface TailFile { path: string; kind: string; sessionId: string; compressed: boolean }
export interface TailRecord { content?: string; raw: string }
export type LineResult<R> = { ok: true; record: R } | { ok: false; reason: 'malformed' } | null;
/** A line above the parse cap, streamed in pieces (EC-15). */
export interface OversizedSink<R> { feed(bytes: Buffer): R[]; end(): { records: R[]; unreadable: boolean } }

export interface TailAdapterOptions {
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
  maxLineBytes?: number; // parse cap (OQ-P1-06): longer lines stream through oversized()
  watch?: WatchFn;
  now?: () => number;
}

type Stored = Checkpoint & { status: SourceFileCheckpoint['status'] };
/** What boot holds of any adapter: its public lifecycle. */
export type Ingester = Pick<TailAdapter<TailFile, TailRecord>, 'start' | 'stop' | 'wake' | 'reads'>;

// In-memory parse cap (D-P1-13, OQ-P1-06 measured): an in-memory line costs about 7x its size in the service (bytes,
// raw and parsed strings, SQLite binds and record build), so 64 MiB could not meet the EC-15 RSS bound; longer lines
// take the bounded streaming path.
export const PARSE_CAP = 8 * 1024 * 1024;

export abstract class TailAdapter<F extends TailFile, R extends TailRecord> {
  protected readonly o: Required<Omit<TailAdapterOptions, 'watch'>> & Pick<TailAdapterOptions, 'watch'>;
  readonly #watcher: Watcher<F>;
  readonly #chains = new Map<string, Promise<void>>(); // one sync at a time per file
  readonly #reads = new Map<string, number>();

  constructor(o: TailAdapterOptions) {
    this.o = { zstd: zstdAvailable, intervalMs: 5000, activeMs: 10 * 60_000, eventsPerBatch: 100, bytesPerBatch: 1 << 20, chunkBytes: 1 << 20, maxLineBytes: PARSE_CAP, now: Date.now, ...o };
    this.#watcher = new Watcher<F>({
      list: () => this.discover(),
      onChange: (f) => void this.sync(f, true).catch(() => undefined), // a failed sync is retried on the next change or scan
      intervalMs: this.o.intervalMs, activeMs: this.o.activeMs, now: this.o.now,
      ...(this.o.watch ? { watch: this.o.watch } : {}),
    });
  }

  protected abstract discover(): Promise<F[]>;
  protected abstract parse(line: Line, file: F, fileMtime: number, receivedTs: number): LineResult<R>;
  protected abstract oversized(file: F, offset: number, fileMtime: number, receivedTs: number): OversizedSink<R>;
  protected abstract toBatch(file: F, cp: SourceFileCheckpoint, records: R[], quarantine: QuarantineRow[]): Batch;
  /** Runs before a file is read; false skips this sync (retried on the next change or scan). */
  protected async prepare(_file: F, _st: Stats, _fromStart: boolean): Promise<boolean> { return true; }
  /** The session a file's quarantine rows belong to. */
  protected fileSession(file: F): string { return file.sessionId; }

  /** Times a file was opened for reading (EC-19: unchanged files are never read). */
  reads(path: string): number { return this.#reads.get(path) ?? 0; }

  async start(): Promise<void> {
    await this.#watcher.start(); // snapshot first, so changes during backfill are seen by the next scan
    const files = await this.discover();
    const withTime = await Promise.all(files.map(async (f) => ({ f, mtime: (await stat(f.path).catch(() => undefined))?.mtimeMs ?? 0 })));
    withTime.sort((a, b) => b.mtime - a.mtime); // newest first
    const now = this.o.now();
    const ordered = [...withTime.filter((x) => now - x.mtime < this.o.activeMs), ...withTime.filter((x) => now - x.mtime >= this.o.activeMs)];
    for (const x of ordered) { // one file at a time, live files first, newest first
      try { await this.sync(x.f, now - x.mtime < this.o.activeMs); } catch { /* retried on the next change or scan */ }
    }
  }

  stop(): void { this.#watcher.stop(); }

  wake(): Promise<void> { return this.#watcher.scan(); }

  sync(file: F, live: boolean): Promise<void> {
    const next = (this.#chains.get(file.path) ?? Promise.resolve()).then(() => this.#sync(file, live));
    // A failed sync (read or commit) makes the watcher forget the file, so the next scan or wake retries it.
    this.#chains.set(file.path, next.catch(() => this.#watcher.forget(file.path)));
    return next;
  }

  #checkpoint(path: string): Stored | undefined {
    const r = this.o.db.prepare('SELECT dev, ino, size, mtime, offset, head_hash, status FROM source_files WHERE path = ?').get(path) as
      { dev: number; ino: number; size: number; mtime: number; offset: number; head_hash: string; status: Stored['status'] } | undefined;
    return r && { dev: r.dev, ino: r.ino, size: r.size, mtime: r.mtime, offset: r.offset, headHash: r.head_hash, status: r.status };
  }

  async #sync(file: F, live: boolean): Promise<void> {
    let st;
    try { st = await stat(file.path); } catch { return; } // gone between discovery and sync
    const cp = this.#checkpoint(file.path);
    const base = { path: file.path, kind: file.kind, dev: st.dev, ino: st.ino, size: st.size, mtime: st.mtimeMs };
    if (file.compressed) {
      if (cp && cp.dev === st.dev && cp.ino === st.ino && cp.size === st.size && cp.mtime === st.mtimeMs) return;
      if (!this.o.zstd) {
        await this.o.writer.enqueue(this.toBatch(file, { ...base, offset: 0, headHash: '', status: 'compressed_not_imported' }, [], []), live);
        return;
      }
      if (!(await this.prepare(file, st, true))) return;
      this.#count(file.path);
      await this.#ingest(file, readZstd(file.path, this.o.chunkBytes), 0, base, live, () => '', 'ok');
      return;
    }
    if (cp && cp.dev === st.dev && cp.ino === st.ino && cp.size === st.size && cp.mtime === st.mtimeMs) return; // nothing new
    const { offset, reset } = await startOffset(file.path, st, cp);
    if (!(await this.prepare(file, st, reset || offset === 0))) return;
    this.#count(file.path);
    let full: string | undefined; // hash of the first HEAD_BYTES once the checkpoint passes them
    const hashAt = async (committed: number) => (committed >= HEAD_BYTES ? (full ??= await headHash(file.path, HEAD_BYTES)) : headHash(file.path, committed));
    const stream = offset < st.size ? readRange(file.path, offset, st.size, this.o.chunkBytes) : Readable.from([]);
    await this.#ingest(file, stream, offset, base, live, hashAt, cp?.status === 'oversized' && !reset ? 'oversized' : 'ok');
  }

  async #ingest(file: F, stream: Readable, from: number, base: Omit<SourceFileCheckpoint, 'offset' | 'headHash' | 'status'>,
    live: boolean, hashAt: (committed: number) => Promise<string> | string, status: 'ok' | 'oversized'): Promise<void> {
    const splitter = new LineSplitter(from, { maxLine: this.o.maxLineBytes });
    let big: OversizedSink<R> | undefined;
    const receivedTs = this.o.now();
    let records: R[] = [];
    let quarantine: QuarantineRow[] = [];
    let bytes = 0;
    let lastEnd = from;
    // An intermediate checkpoint records only the bytes examined so far, so a restart after a crash reads the rest;
    // the final one records the whole size seen at stat time (a trailing partial line stays after `offset`). Each
    // batch is awaited: a failed commit throws and stops this file, so no later checkpoint can pass the lost records.
    const flush = async (final = false) => {
      const cp = { ...base, size: final ? base.size : lastEnd, offset: lastEnd, headHash: await hashAt(lastEnd), status };
      const committed = this.o.writer.enqueue(this.toBatch(file, cp, records, quarantine), live);
      records = [];
      quarantine = [];
      bytes = 0;
      if (final) this.o.writer.flush(); // each batch is its own transaction; no reason to wait for the timer
      await committed;
    };
    const take = (line: Line) => {
      const r = this.parse(line, file, base.mtime, receivedTs);
      if (r?.ok) records.push(r.record);
      else if (r) quarantine.push({ nativeSessionId: this.fileSession(file), byteOffset: line.offset, reason: 'malformed', raw: line.bytes, receivedTs });
      bytes += line.bytes.length;
      lastEnd = line.offset + line.bytes.length + 1;
    };
    const takeBig = (rs: R[]) => { for (const r of rs) { records.push(r); bytes += (r.content?.length ?? 0) + r.raw.length; } };
    for await (const chunk of stream) {
      for (const p of splitter.pushPieces(chunk as Buffer)) {
        if (!('big' in p)) take(p);
        else if (p.big === 'start') big = this.oversized(file, p.offset, base.mtime, receivedTs);
        else if (p.big === 'data') takeBig(big!.feed(p.bytes));
        else { // the oversized line is complete (EC-15): head row last; a gap only for what could not be read
          const r = big!.end();
          takeBig(r.records);
          if (r.unreadable) { quarantine.push({ nativeSessionId: this.fileSession(file), byteOffset: p.offset, reason: 'oversized-unreadable', receivedTs }); status = 'oversized'; }
          big = undefined;
          lastEnd = p.offset + p.length + 1;
        }
        if (records.length >= this.o.eventsPerBatch || bytes >= this.o.bytesPerBatch) await flush();
      }
    }
    lastEnd = splitter.committedOffset; // stops before a trailing partial line (EC-14)
    await flush(true); // always: the last batch stores the final size/mtime, even with no new records
  }

  #count(path: string): void { this.#reads.set(path, (this.#reads.get(path) ?? 0) + 1); }
}
