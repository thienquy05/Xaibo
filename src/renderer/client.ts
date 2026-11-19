// The renderer's side of the brokered service port (P1-T12): numbered requests, each resolved only by its own reply;
// pushed deltas and agent status go to their handlers; every message is validated (src/shared/ipc.ts) and invalid ones
// are counted; an invalid reply rejects its request, so the caller can recover. A service restart brings a new port
// and a new client; replies owed on the old one never arrive.
import { accept, IPC_VERSION, isObj, parsePortMessage } from '../shared/ipc.ts';
import type { AgentStatus, Banner, CostDetail, Cursor, FileItem, HistoryCursor, HistoryFilter, HistoryKey, HistoryRow, LedgerFilter, MapGroup, MapNode, MCursor, ModelMarker, Named, OverlayOp, OverlayResult, Page, PortMessage, PortRequest, SessionDetail, SessionRow, SubagentItem, TCursor, ToolItem, TranscriptAt, TranscriptItem, UsageRecord, UsageScope } from '../shared/ipc.ts';

export interface LiveSet { rows: SessionRow[]; more: boolean }
export interface PortLike { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void; close(): void }
/** delta: the perf-trace id of a sessions push (P3-T10), present only under XAIBO_PERF_TRACE=1. */
export interface Pushes {
  sessions(rows: SessionRow[], delta?: number): void; agents(agents: AgentStatus[] | null): void; coverage?(banners: Banner[]): void;
  /** P4-T10c1: the service dropped a delta too large to send; reload by cursor. */
  resync?(): void;
}

/** P4-T02: main's window hide/show, forwarded by the preload as `{ xaiboVisible: boolean }`; anything else is null. */
export function parseVisible(x: unknown): boolean | null {
  return isObj(x) && typeof x.xaiboVisible === 'boolean' ? x.xaiboVisible : null;
}

type Reply = Extract<PortMessage, { id: number }>;
/** A request as a method writes it; `ask` adds the version and the id. */
type Body = PortRequest extends infer R ? (R extends { id: number } ? Omit<R, 'v' | 'id'> : never) : never;

export function createClient(port: PortLike, push: Pushes) {
  let nextId = 1;
  // One pending map: a reply settles only the request with its id and of its own type (P4-T04b1).
  const pending = new Map<number, { type: Reply['type']; resolve: (m: Reply) => void; reject: (e: Error) => void }>();
  const receive = accept(parsePortMessage, (m) => {
    if ('id' in m) {
      const p = pending.get(m.id);
      if (p?.type === m.type) { pending.delete(m.id); p.resolve(m); }
    } else if (m.type === 'sessions') push.sessions(m.rows, m.delta);
    else if (m.type === 'coverage') push.coverage?.(m.banners);
    else if (m.type === 'resync') push.resync?.();
    else push.agents(m.agents);
  });
  port.onmessage = (e) => {
    const dropped = receive.dropped;
    receive(e.data);
    const m = e.data as { type?: unknown; id?: unknown } | null;
    if (receive.dropped !== dropped && typeof m?.id === 'number') { // only a pending reply's own type matches below
      const p = pending.get(m.id);
      if (p && p.type === m.type) { pending.delete(m.id); p.reject(new Error('invalid reply')); }
    }
  };
  const ask = <T extends Reply['type']>(body: Body, type: T) => new Promise<Extract<Reply, { type: T }>>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { type, resolve: resolve as (m: Reply) => void, reject });
    port.postMessage({ ...body, v: IPC_VERSION, id });
  });
  return {
    async listSessions(cursor: Cursor | null, limit: number): Promise<Page> {
      const m = await ask({ type: 'listSessions', cursor, limit }, 'page');
      return { rows: m.rows, next: m.next };
    },
    /** P4-T04a: the live-session set (capped; `more` when it was). */
    async liveSet(): Promise<LiveSet> {
      const m = await ask({ type: 'liveSet' }, 'liveSet');
      return { rows: m.rows, more: m.more };
    },
    /** P4-T04b1: usage scopes with their newest measurements. */
    async usage(): Promise<UsageScope[]> { return (await ask({ type: 'usage' }, 'usage')).scopes; },
    /** P5-T17a/b: one page of the monthly usage ledger (failed = the store could not answer). */
    async monthly(filter: LedgerFilter, end: string | null, limit: number) {
      const { v: _v, type: _t, id: _i, ...page } = await ask({ type: 'monthly', filter, end, limit }, 'monthly');
      return page;
    },
    /** P5-T16: Clear usage history (after the owner's confirmation). */
    async clearUsage() { return (await ask({ type: 'clearUsage' }, 'clearUsage')).result; },
    /** P4-T04b1: one scope+stream's observations in [from, to). */
    async usageHistory(scope: number, stream: string, from: number, to: number, cursor: HistoryCursor | null, limit: number): Promise<{ records: UsageRecord[]; next: HistoryCursor | null }> {
      const m = await ask({ type: 'usageHistory', scope, stream, from, to, cursor, limit }, 'usageHistory');
      return { records: m.records, next: m.next };
    },
    // P4-T05c (XAIBO-PROD-412): one session's workspace pages (design §6.3); each settles only on its own reply.
    async session(session: number): Promise<SessionDetail | null> { return (await ask({ type: 'session', session }, 'session')).detail; },
    async transcript(session: number, at: TranscriptAt, limit: number): Promise<{ items: TranscriptItem[]; prev: TCursor | null; next: TCursor | null }> {
      const m = await ask({ type: 'transcript', session, at, limit }, 'transcript');
      return { items: m.items, prev: m.prev, next: m.next };
    },
    async slice(session: number, event: number, part: 'text' | 'reasoning', offset: number, call?: string): Promise<{ text: string; next: number | null }> {
      const m = await ask({ type: 'slice', session, event, part, offset, ...(call !== undefined ? { call } : {}) }, 'slice');
      return { text: m.text, next: m.next };
    },
    async tools(session: number, cursor: number | null, limit: number): Promise<{ calls: ToolItem[]; next: number | null }> {
      const m = await ask({ type: 'tools', session, cursor, limit }, 'tools');
      return { calls: m.calls, next: m.next };
    },
    async subagents(session: number, cursor: number | null, limit: number): Promise<{ subagents: SubagentItem[]; next: number | null }> {
      const m = await ask({ type: 'subagents', session, cursor, limit }, 'subagents');
      return { subagents: m.subagents, next: m.next };
    },
    async files(session: number, cursor: number | null, limit: number): Promise<{ touches: FileItem[]; next: number | null }> {
      const m = await ask({ type: 'files', session, cursor, limit }, 'files');
      return { touches: m.touches, next: m.next };
    },
    async markers(session: number, cursor: MCursor | null, limit: number): Promise<{ markers: ModelMarker[]; next: MCursor | null }> {
      const m = await ask({ type: 'markers', session, cursor, limit }, 'markers');
      if (m.failed) throw new Error('markers unavailable');
      return { markers: m.markers, next: m.next };
    },
    /** XAIBO-PROD-504 (P5-T01): the history list (pinned first), project and folder pages, and overlay actions. */
    async history(filter: HistoryFilter, cursor: HistoryKey | null, limit: number): Promise<{ rows: HistoryRow[]; next: HistoryKey | null }> {
      const m = await ask({ type: 'history', filter, cursor, limit }, 'history');
      return { rows: m.rows, next: m.next };
    },
    async projects(cursor: number | null, limit: number): Promise<{ projects: Named[]; next: number | null }> {
      const m = await ask({ type: 'projects', cursor, limit }, 'projects');
      return { projects: m.projects, next: m.next };
    },
    async folders(project: number, cursor: number | null, limit: number): Promise<{ folders: Named[]; next: number | null }> {
      const m = await ask({ type: 'folders', project, cursor, limit }, 'folders');
      return { folders: m.folders, next: m.next };
    },
    /** XAIBO-PROD-510 (P5-T01c): a page of map groups under parent (null = roots); throws when the store could not answer. */
    async mapGroups(parent: MapGroup | null, cursor: MapGroup | null, limit: number): Promise<{ groups: MapNode[]; next: MapGroup | null }> {
      const m = await ask({ type: 'mapGroups', parent, cursor, limit }, 'mapGroups');
      if (m.failed) throw new Error('map groups unavailable');
      return { groups: m.groups, next: m.next };
    },
    async overlay(op: OverlayOp): Promise<OverlayResult> { return (await ask({ type: 'overlay', op }, 'overlay')).result; },
    /** P4-T07a: the session's cost breakdown; null for an unknown session. */
    async cost(session: number): Promise<CostDetail | null> { return (await ask({ type: 'cost', session }, 'cost')).cost; },
    /** P4-T02: live session deltas while the window is visible; paused while hidden (resync by cursor on show). */
    setLive(on: boolean): void { port.postMessage({ v: IPC_VERSION, type: 'live', on } satisfies PortRequest); },
    get dropped() { return receive.dropped; },
    // XAIBO-PROD-434: a request still waiting on this port settles now (a restarted service answers on its new port);
    // left unsettled, the section that asked would stay loading and never refetch
    close() { port.onmessage = null; for (const p of pending.values()) p.reject(new Error('closed')); pending.clear(); port.close(); },
  };
}
export type Client = ReturnType<typeof createClient>;
