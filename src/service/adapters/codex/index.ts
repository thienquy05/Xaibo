// Codex adapter (P2-T03): rollout backfill and tail on the shared file-sync engine (../tail-adapter.ts). Native ids are
// file identity (the first complete line) + byte offset, so archive moves and copies add nothing (OQ-P2-02). The
// session is the session_meta id; a different filename id is a coverage warning.
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { Readable } from 'node:stream';
import type { Line } from '../../lines.ts';
import { cwdKey } from '../../paths.ts';
import type { Batch, EventRow, QuarantineRow, SessionUpsert, SourceFileCheckpoint } from '../../store/writer.ts';
import { readRange, readZstd } from '../../tail.ts';
import { TailAdapter, type OversizedSink } from '../tail-adapter.ts';
import { discover, type CodexFile } from './discover.ts';
import { parseLine, type CodexRecord } from './parse.ts';

/** Hash of the first line (without its newline) and, when within `cap`, its bytes; undefined until the line is complete. */
async function firstLine(stream: Readable, cap: number): Promise<{ identity: string; bytes?: Buffer } | undefined> {
  const hash = createHash('sha256');
  const parts: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const nl = chunk.indexOf(0x0a);
      const piece = nl < 0 ? chunk : chunk.subarray(0, nl);
      hash.update(piece);
      if (length + piece.length <= cap) parts.push(Buffer.from(piece));
      length += piece.length;
      if (nl >= 0) return { identity: hash.digest('hex').slice(0, 16), ...(length <= cap ? { bytes: Buffer.concat(parts) } : {}) };
    }
    return undefined;
  } finally {
    stream.destroy();
  }
}

export class CodexAdapter extends TailAdapter<CodexFile, CodexRecord> {
  readonly #files = new Map<string, { identity: string; sessionId: string }>(); // per path, from the first line

  protected discover(): Promise<CodexFile[]> { return discover(this.o.root); }

  // ponytail: the identity is cached per path and recomputed when the tail engine restarts a file from 0 (rotation,
  // truncation, a changed head); an in-place edit of the first line beyond its first 4 KiB is not noticed.
  protected override async prepare(file: CodexFile, st: Stats, fromStart: boolean): Promise<boolean> {
    if (!fromStart && this.#files.has(file.path)) return true;
    const stream = file.compressed ? readZstd(file.path, this.o.chunkBytes) : readRange(file.path, 0, st.size, this.o.chunkBytes);
    const first = await firstLine(stream, this.o.maxLineBytes);
    if (!first) return false; // first line not complete yet: native ids would change; the next change retries
    const meta = first.bytes ? parseLine(first.bytes, { offset: 0, fileIdentity: first.identity, fileMtime: 0, receivedTs: 0 }) : null;
    const metaId = meta?.ok && meta.record.kind === 'session' ? meta.record.sessionId : undefined;
    this.#files.set(file.path, { identity: first.identity, sessionId: metaId ?? file.sessionId });
    return true;
  }

  protected override fileSession(file: CodexFile): string { return this.#files.get(file.path)?.sessionId ?? file.sessionId; }

  protected parse(line: Line, file: CodexFile, fileMtime: number, receivedTs: number) {
    return parseLine(line.bytes, { offset: line.offset, fileIdentity: this.#files.get(file.path)!.identity, fileMtime, receivedTs });
  }

  // ponytail: a Codex line above the parse cap is recorded as a gap without content (S9 saw no such line; the Claude
  // tokenizer's readable paths are Claude's); add Codex readable paths to a streaming tokenizer if real rollouts need it.
  protected oversized(): OversizedSink<CodexRecord> {
    return { feed: () => [], end: () => ({ records: [], unreadable: true }) };
  }

  protected toBatch(file: CodexFile, cp: SourceFileCheckpoint, records: CodexRecord[], quarantine: QuarantineRow[]): Batch {
    const sid = this.fileSession(file);
    const s: SessionUpsert = { nativeSessionId: sid, nativeArchived: file.archived };
    const events: EventRow[] = records.map((r) => {
      if (r.cwd && !s.cwd) { s.cwd = r.cwd; s.cwdKey = cwdKey(r.cwd); }
      if (r.kind === 'session') {
        if (r.source && !s.entrypoint) s.entrypoint = r.source;
        if (r.originator && !s.originator) s.originator = r.originator;
        if (r.sessionId && r.sessionId !== file.sessionId) {
          quarantine.push({ nativeSessionId: sid, byteOffset: r.sourceSeq, reason: 'session-id-mismatch', receivedTs: r.receivedTs });
        }
      }
      if (r.sourceTs !== undefined) {
        s.lastActivity = Math.max(s.lastActivity ?? r.sourceTs, r.sourceTs);
        s.startedAt = Math.min(s.startedAt ?? r.sourceTs, r.sourceTs);
      }
      return {
        nativeSessionId: sid, source: 'rollout', confidence: 'confirmed', nativeId: r.nativeId, kind: r.kind, role: r.role,
        byteOffset: r.sourceSeq, sourceSeq: r.sourceSeq, sourceTs: r.sourceTs, fileMtime: r.fileMtime, receivedTs: r.receivedTs,
        injected: r.injected, content: r.content, raw: r.raw,
      };
    });
    if (records.length && s.lastActivity === undefined) s.lastActivity = cp.mtime; // records but none with a timestamp
    return { profileId: this.o.profileId, agent: 'codex', file: cp, fileSession: sid, sessions: [s], events, quarantine };
  }
}
