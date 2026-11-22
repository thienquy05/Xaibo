// Codex adapter (P2-T03): rollout backfill and tail on the shared file-sync engine (../tail-adapter.ts). Native ids are
// file identity (the first complete line) + byte offset, so archive moves and copies add nothing (OQ-P2-02). The
// session is the session_meta id; a different filename id is a coverage warning.
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { isObj } from '../../../shared/ipc.ts';
import type { Line } from '../../lines.ts';
import { cwdKey } from '../../paths.ts';
import { noteCwd, type Batch, type EventRow, type QuarantineRow, type SessionUpsert, type SourceFileCheckpoint } from '../../store/writer.ts';
import { readRange, readZstd } from '../../tail.ts';
import { TailAdapter, type OversizedSink } from '../tail-adapter.ts';
import { discover, type CodexFile } from './discover.ts';
import { reconcileNative } from '../../history/native-availability.ts';
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

// P2-T05: custom_tool_call / _output join on call_id; task_started / task_complete / turn_aborted bound a turn.
const toolCalls = (r: CodexRecord): EventRow['toolCalls'] => {
  if (!r.callId || (r.kind !== 'tool_call' && r.kind !== 'tool_result')) return undefined;
  return [{ callId: r.callId, part: r.kind === 'tool_call' ? 'args' : 'result', ...(r.toolName ? { tool: r.toolName } : {}) }];
};
const turnEdge = (r: CodexRecord): EventRow['turn'] => {
  if (!r.turnId) return undefined;
  if (r.kind === 'turn_start') return { id: r.turnId, edge: 'start' };
  if (r.kind === 'turn_end') return { id: r.turnId, edge: 'end', outcome: 'completed' };
  if (r.kind === 'turn_aborted') return { id: r.turnId, edge: 'end', outcome: 'aborted' };
  return undefined;
};

// P2-T06: token_count carries cumulative totals, the last request and rate_limits; token_usage_record is checked for drift.
const usageOf = (r: CodexRecord): EventRow['usage'] => {
  const obj = (v: unknown) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
  if (r.kind === 'token_count') {
    const total = obj(r.tokenInfo?.total_token_usage);
    const last = obj(r.tokenInfo?.last_token_usage);
    return { kind: 'codex-count', ...(total ? { total } : {}), ...(last ? { last } : {}), ...(r.rateLimits ? { rateLimits: r.rateLimits } : {}) };
  }
  return r.kind === 'token_usage' && r.usage ? { kind: 'codex-record', payload: r.usage } : undefined;
};

// P2-T08: turn_context model + collaboration_mode reasoning_effort per turn; thread_settings_applied for the session.
const modelOf = (r: CodexRecord): EventRow['model'] => {
  if (!r.model || (r.kind !== 'turn_context' && r.kind !== 'settings')) return undefined;
  return { id: r.model, ...(r.effort !== undefined ? { effort: r.effort } : {}), ...(r.kind === 'turn_context' && r.turnId ? { turn: r.turnId } : {}) };
};

// P2-T07: last request total over the reported model_context_window; the model is the session's current one at write time.
const contextOf = (r: CodexRecord): EventRow['context'] => {
  const at = r.sourceTs ?? null;
  if (r.kind === 'compaction') return { kind: 'compaction', postTokens: null, at, locator: r.nativeId };
  if (r.kind !== 'token_count' || !r.tokenInfo) return undefined;
  const last = r.tokenInfo.last_token_usage as Record<string, unknown> | undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return { kind: 'codex', model: null, used: n(last?.total_tokens), window: n(r.tokenInfo.model_context_window), at, locator: r.nativeId };
};

// XAIBO-PROD-508 (P5-T02b, D-P5-03): thread names from <CODEX_HOME>/session_index.jsonl, one {id, thread_name,
// updated_at} per line (S9-C3); Codex 0.160.0 rewrites it through session_index.jsonl.tmp + rename and may append.
// ponytail: an index above INDEX_MAX is skipped, and a name dropped from the index keeps the stored title.
export const INDEX_MAX = 16 * 1024 * 1024;

/** The last non-empty thread_name per id; malformed lines and a partial trailing line (a concurrent append) are skipped. */
export function threadNames(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split('\n');
  if (!text.endsWith('\n')) lines.pop();
  for (const l of lines) {
    let r: unknown;
    try { r = JSON.parse(l); } catch { continue; }
    if (isObj(r) && typeof r.id === 'string' && typeof r.thread_name === 'string' && r.thread_name.trim()) out.set(r.id, r.thread_name);
  }
  return out;
}

export class CodexAdapter extends TailAdapter<CodexFile, CodexRecord> {
  readonly #files = new Map<string, { identity: string; sessionId: string }>(); // per path, from the first line
  readonly #names = new Map<string, string>(); // thread names last read from the index
  #indexSig = '';

  // Every scan lists rollouts here, so the index is checked first: rollouts ingested in this scan take their names.
  protected async discover(): Promise<CodexFile[]> {
    // A failed read or commit forgets everything read, so the next scan sends every name again (review M2).
    await this.#threadNames().catch(() => { this.#indexSig = ''; this.#names.clear(); });
    const files = await discover(this.o.root);
    // P5-T12 (EC-24): native availability; a move to archived_sessions/ is listed under the same id, so never a deletion
    await reconcileNative({ db: this.o.db, writer: this.o.writer, profileId: this.o.profileId, agent: 'codex', kinds: ['rollout'] }, files).catch(() => undefined);
    return files;
  }

  /** Re-reads the index only when its signature changes (a rename changes the inode). One handle, never following a
   *  symlink or blocking on a FIFO, read up to its fstat size (review M1). Changed names go to stored sessions as an
   *  update-only batch, which never creates a session; the file is only read. */
  async #threadNames(): Promise<void> {
    let fh;
    try { fh = await open(path.join(this.o.root, 'session_index.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return; }
    let sig: string;
    let text: string;
    try {
      const st = await fh.stat();
      sig = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
      if (sig === this.#indexSig || !st.isFile() || st.size > INDEX_MAX) return;
      const buf = Buffer.alloc(st.size);
      text = buf.subarray(0, (await fh.read(buf, 0, st.size, 0)).bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
    const changed = [...threadNames(text)].filter(([id, n]) => this.#names.get(id) !== n);
    // Names are taken before the commit, so a rollout batch built meanwhile carries them (review M2).
    for (const [id, n] of changed) this.#names.set(id, n);
    if (changed.length) {
      await this.o.writer.enqueue({ profileId: this.o.profileId, agent: 'codex', events: [],
        sessions: changed.map(([id, title]) => ({ nativeSessionId: id, title, existing: true })) }, false);
    }
    this.#indexSig = sig;
  }

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
    return parseLine(line.bytes, { offset: line.offset, fileIdentity: this.#files.get(file.path)!.identity, fileMtime, receivedTs, accountSalt: this.o.accountSalt ?? null });
  }

  // ponytail: a Codex line above the parse cap is recorded as a gap without content (S9 saw no such line; the Claude
  // tokenizer's readable paths are Claude's); add Codex readable paths to a streaming tokenizer if real rollouts need it.
  protected oversized(): OversizedSink<CodexRecord> {
    return { feed: () => [], end: () => ({ records: [], unreadable: true }) };
  }

  protected toBatch(file: CodexFile, cp: SourceFileCheckpoint, records: CodexRecord[], quarantine: QuarantineRow[]): Batch {
    const sid = this.fileSession(file);
    const s: SessionUpsert = { nativeSessionId: sid, nativeArchived: file.archived };
    const title = this.#names.get(sid);
    if (title) s.title = title;
    const events: EventRow[] = records.map((r) => {
      if (r.cwd && !s.cwd) { s.cwd = r.cwd; s.cwdKey = cwdKey(r.cwd); }
      if (r.cwd) noteCwd(s, r.cwd, r.sourceTs, 'rollout'); // session_meta and turn_context (EC-06)
      if (r.kind === 'session') {
        if (r.source && !s.entrypoint) s.entrypoint = r.source;
        if (r.originator && !s.originator) s.originator = r.originator;
        if (r.accountEpoch && !s.accountEpoch) s.accountEpoch = r.accountEpoch; // P3-T15: scope marker, never the raw id
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
        injected: r.injected, content: r.content, raw: r.raw, toolCalls: toolCalls(r), turn: turnEdge(r), usage: usageOf(r), model: modelOf(r), context: contextOf(r),
      };
    });
    if (records.length && s.lastActivity === undefined) s.lastActivity = cp.mtime; // records but none with a timestamp
    return { profileId: this.o.profileId, agent: 'codex', file: cp, fileSession: sid, sessions: [s], events, quarantine };
  }
}
