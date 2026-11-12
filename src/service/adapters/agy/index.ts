// agy adapter (P2-T11, D-P2-02): transcript_full.jsonl backfill and tail on the shared engine. Session = conversation
// folder id; cwd from history.jsonl (conversationId -> workspace, read incrementally; prompt text never kept). Records
// carry `revise`, so rewrites, truncations and lower-step appends are applied in source order by the writer
// (agy rewrite semantics unverified; EC-80). Cleanup (EC-81): a vanished conversation folder under a readable brain/
// marks the session native-unavailable; a missing transcript in a present folder is a gap; a restored folder is
// available again. No native writes, no agent SQLite opened.
// ponytail: a replay after a rewrite commits in bounded batches, so a reader can briefly see later steps as rewound
// until the replay reaches them; one transaction per replay if that window matters.
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { LineSplitter, type Line } from '../../lines.ts';
import { cwdKey } from '../../paths.ts';
import { noteCwd, type Batch, type EventRow, type QuarantineRow, type SessionUpsert, type SourceFileCheckpoint } from '../../store/writer.ts';
import { readRange } from '../../tail.ts';
import { TailAdapter, type OversizedSink } from '../tail-adapter.ts';
import { scan, transcriptOf, type AgyFile } from './discover.ts';
import { parseLine, type AgyRecord } from './parse.ts';

const HISTORY_LINE_MAX = 64 * 1024;
type Known = { path: string; dev: number; ino: number; size: number; mtime: number; offset: number; headHash: string; status: string; sid: string; avail: number };

export class AgyAdapter extends TailAdapter<AgyFile, AgyRecord> {
  readonly #cwd = new Map<string, string>();
  #history = { ino: -1, offset: 0 };

  protected async discover(): Promise<AgyFile[]> {
    const s = await scan(this.o.root);
    if (s.home && s.brainReadable) await this.#reconcile(s.home, new Set(s.files.map((f) => f.path)));
    return s.files;
  }

  async #reconcile(home: string, listed: Set<string>): Promise<void> {
    const known = this.o.db.prepare(`SELECT f.path, f.dev, f.ino, f.size, f.mtime, f.offset, f.head_hash AS headHash, f.status, s.native_session_id AS sid,
      s.native_available AS avail FROM source_files f JOIN sessions s ON s.id = f.session_id WHERE f.profile_id = ? AND f.kind = 'agy-transcript'`).all(this.o.profileId) as Known[];
    for (const k of known) {
      const present = listed.has(k.path);
      const gone = k.status === 'gone';
      // G2-4: a gone transcript whose session is still available is reassessed, so a later folder deletion is seen.
      if (present ? !gone : gone && k.avail === 0) continue;
      let session: SessionUpsert = { nativeSessionId: k.sid, nativeAvailable: true }; // restored
      const quarantine: QuarantineRow[] = [];
      if (!present) {
        const missing = async (p: string) => { try { await lstat(p); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT'; } };
        if (await missing(path.join(home, 'brain', k.sid))) session = { nativeSessionId: k.sid, nativeAvailable: false };
        else if (gone) continue; // already recorded as a missing transcript; nothing new
        else if (await missing(transcriptOf(home, k.sid))) {
          session = { nativeSessionId: k.sid };
          quarantine.push({ nativeSessionId: k.sid, byteOffset: -1, reason: 'transcript-missing', receivedTs: this.o.now() });
        } else continue; // present but refused (not a regular contained file): never proof of anything
      }
      const file: SourceFileCheckpoint = { path: k.path, kind: 'agy-transcript', dev: k.dev, ino: k.ino, size: k.size, mtime: k.mtime, offset: k.offset,
        headHash: k.headHash, status: present ? 'ok' : 'gone' };
      await this.o.writer.enqueue({ profileId: this.o.profileId, agent: 'agy', file, fileSession: k.sid, sessions: [session], events: [], quarantine }, false);
    }
  }

  protected override async prepare(): Promise<boolean> {
    await this.#readHistory();
    return true;
  }

  /** conversationId -> workspace from history.jsonl, appended lines only; lines above the bound are skipped. */
  async #readHistory(): Promise<void> {
    let file: string;
    try { file = path.join(await realpath(this.o.root), 'history.jsonl'); } catch { return; }
    let st;
    try { st = await lstat(file); } catch { return; }
    if (!st.isFile()) return;
    if (st.ino !== this.#history.ino || st.size < this.#history.offset) this.#history = { ino: st.ino, offset: 0 };
    if (st.size === this.#history.offset) return;
    const splitter = new LineSplitter(this.#history.offset, { maxLine: HISTORY_LINE_MAX });
    for await (const chunk of readRange(file, this.#history.offset, st.size, this.o.chunkBytes)) {
      for (const p of splitter.pushPieces(chunk as Buffer)) {
        if ('big' in p) continue;
        try {
          const o = JSON.parse(p.bytes.toString('utf8')) as { conversationId?: unknown; workspace?: unknown };
          if (typeof o.conversationId === 'string' && typeof o.workspace === 'string' && o.workspace.startsWith('/')) this.#cwd.set(o.conversationId, o.workspace);
        } catch { /* not a history entry */ }
      }
    }
    this.#history.offset = splitter.committedOffset;
  }

  protected parse(line: Line, _file: AgyFile, fileMtime: number, receivedTs: number) {
    return parseLine(line.bytes, { offset: line.offset, fileMtime, receivedTs });
  }

  // ponytail: an agy line above the parse cap is a gap without content (T00 saw none), as for Codex.
  protected oversized(): OversizedSink<AgyRecord> {
    return { feed: () => [], end: () => ({ records: [], unreadable: true }) };
  }

  protected toBatch(file: AgyFile, cp: SourceFileCheckpoint, records: AgyRecord[], quarantine: QuarantineRow[]): Batch {
    const sid = file.sessionId;
    const s: SessionUpsert = { nativeSessionId: sid, nativeAvailable: true };
    const cwd = this.#cwd.get(sid);
    if (cwd) { s.cwd = cwd; s.cwdKey = cwdKey(cwd); noteCwd(s, cwd, undefined, 'history'); }
    const events: EventRow[] = records.map((r) => {
      if (r.sourceTs !== undefined) {
        s.lastActivity = Math.max(s.lastActivity ?? r.sourceTs, r.sourceTs);
        s.startedAt = Math.min(s.startedAt ?? r.sourceTs, r.sourceTs);
      }
      const call = r.step === null ? r.nativeId : `step:${r.step}`;
      return {
        nativeSessionId: sid, source: 'transcript', confidence: 'confirmed', nativeId: r.nativeId, kind: r.kind, role: r.role, sourceSeq: r.sourceSeq,
        sourceTs: r.sourceTs, fileMtime: r.fileMtime, receivedTs: r.receivedTs, injected: r.injected, content: r.content, raw: r.raw, revise: r.step !== null,
        toolCalls: r.toolNames.map((tool, i) => ({ callId: `${call}:${i}`, part: 'args' as const, tool })), // no id in transcripts: unlinked
        usage: r.usage && r.step !== null ? { kind: 'agy', identity: `step:${r.step}`, raw: r.usage } : undefined,
      };
    });
    if (records.length && s.lastActivity === undefined) s.lastActivity = cp.mtime;
    return { profileId: this.o.profileId, agent: 'agy', file: cp, fileSession: sid, sessions: [s], events, quarantine };
  }
}
