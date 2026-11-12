// Claude adapter (P1-T10): backfill newest-first (live files ahead), then tail via the watcher; the file-sync engine
// lives in ../tail-adapter.ts (shared with Codex since P2-T03). This file holds the Claude-specific parts.
import type { Line } from '../../lines.ts';
import { cwdKey } from '../../paths.ts';
import { claudeUsage } from '../../usage/tokens.ts';
import { noteCwd, type Batch, type EventRow, type QuarantineRow, type SessionUpsert, type SourceFileCheckpoint } from '../../store/writer.ts';
import { TailAdapter, type OversizedSink, type TailAdapterOptions } from '../tail-adapter.ts';
import { discover, type ClaudeFile } from './discover.ts';
import { OversizedRecord } from './oversized.ts';
import { parseLine, type ClaudeRecord } from './parse.ts';

export { PARSE_CAP } from '../tail-adapter.ts';
export type ClaudeAdapterOptions = TailAdapterOptions;

// A turn starts at a main-thread user record typed by the user: not injected, not a tool result, with a uuid (P2-T05).
// The transcript has no turn-end record, so the end stays unavailable (NULL) until hooks (Phase 3).
const prompt = (r: ClaudeRecord) => r.type === 'user' && r.role === 'user' && !r.injected && !r.isSidechain && !r.subagentNativeId
  && !r.nativeId.startsWith('h:') && !!r.content && !r.toolCalls?.some((c) => c.part === 'result');

// P2-T07: main-thread context only. Used = input + cache read + cache creation of the latest response (output excluded).
const contextOf = (r: ClaudeRecord): EventRow['context'] => {
  if (r.isSidechain || r.subagentNativeId) return undefined;
  const at = r.sourceTs ?? null;
  if (r.compact) return { kind: 'compaction', postTokens: r.compact.postTokens, at, locator: r.nativeId };
  if (r.type !== 'assistant' || !r.usage) return undefined;
  const u = claudeUsage(r.usage);
  const used = u.uncachedInput !== null && u.cacheRead !== null && u.cacheWrite !== null ? u.uncachedInput + u.cacheRead + u.cacheWrite : null;
  return { kind: 'claude-usage', model: r.model ?? null, used, at, locator: r.nativeId };
};

export class ClaudeAdapter extends TailAdapter<ClaudeFile, ClaudeRecord> {
  protected discover(): Promise<ClaudeFile[]> { return discover(this.o.root); }

  protected parse(line: Line, file: ClaudeFile, fileMtime: number, receivedTs: number) {
    return parseLine(line.bytes, { offset: line.offset, fileMtime, receivedTs, subagentNativeId: file.subagentId });
  }

  protected oversized(file: ClaudeFile, offset: number, fileMtime: number, receivedTs: number): OversizedSink<ClaudeRecord> {
    return new OversizedRecord({ offset, source: file.path, fileMtime, receivedTs, subagentNativeId: file.subagentId });
  }

  protected toBatch(file: ClaudeFile, cp: SourceFileCheckpoint, records: ClaudeRecord[], quarantine: QuarantineRow[]): Batch {
    const sessions = new Map<string, SessionUpsert>();
    const session = (sid: string) => sessions.get(sid) ?? sessions.set(sid, { nativeSessionId: sid }).get(sid)!;
    session(file.sessionId);
    const events: EventRow[] = records.map((r) => {
      const sid = r.sessionId ?? file.sessionId;
      const s = session(sid);
      if (r.cwd && !s.cwd) { s.cwd = r.cwd; s.cwdKey = cwdKey(r.cwd); }
      if (r.cwd) noteCwd(s, r.cwd, r.sourceTs, 'transcript');
      if (r.entrypoint && !s.entrypoint) s.entrypoint = r.entrypoint;
      if (r.sourceTs !== undefined) {
        s.lastActivity = Math.max(s.lastActivity ?? r.sourceTs, r.sourceTs);
        s.startedAt = Math.min(s.startedAt ?? r.sourceTs, r.sourceTs);
      }
      return {
        nativeSessionId: sid, source: 'transcript', confidence: 'confirmed', nativeId: r.nativeId, parentNativeId: r.parentNativeId,
        messageId: r.messageId, kind: r.kind, role: r.role, subagentNativeId: r.subagentNativeId, byteOffset: r.sourceSeq,
        sourceSeq: r.sourceSeq, sourceTs: r.sourceTs, fileMtime: r.fileMtime, receivedTs: r.receivedTs, injected: r.injected,
        content: r.content, raw: r.raw === '' ? undefined : r.raw, ingestId: r.ingestId, toolCalls: r.toolCalls,
        turn: prompt(r) ? { id: r.nativeId, edge: 'start' } : undefined,
        usage: r.type === 'assistant' && r.messageId && r.usage ? { kind: 'claude', messageId: r.messageId, model: r.model, raw: r.usage } : undefined,
        // P2-T08: main-thread message.model only (subagent models belong to the subagent); transcripts carry no effort (S9)
        model: r.type === 'assistant' && r.model && !r.isSidechain && !r.subagentNativeId ? { id: r.model } : undefined,
        context: contextOf(r),
      };
    });
    const own = session(file.sessionId);
    if (records.length && own.lastActivity === undefined) own.lastActivity = cp.mtime; // records but none with a timestamp
    return {
      profileId: this.o.profileId, agent: 'claude', file: cp, fileSession: file.sessionId, sessions: [...sessions.values()], events, quarantine,
      subagents: file.kind === 'subagent' && file.subagentId ? [{ nativeSessionId: file.sessionId, nativeId: file.subagentId }] : [],
    };
  }
}
