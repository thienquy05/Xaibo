// The renderer's side of the brokered service port (P1-T12): numbered requests, each resolved only by its own reply;
// pushed deltas and agent status go to their handlers; every message is validated (src/shared/ipc.ts) and invalid ones
// are counted; an invalid reply rejects its request, so the caller can recover. A service restart brings a new port
// and a new client; replies owed on the old one never arrive.
import { type CatalogImportResult, accept, IPC_VERSION, isObj, parsePortMessage } from '../shared/ipc.ts';
import type { SignInCommand } from './usage/sign-in-view.ts';
import type { CleanupReply, ConnectReply, LockClearPreviewReply, IntegrationDetailResult, IntegrationKey, IntegrationPageResult, PriceOp, RemovalReply, RetentionSetting, RevokeResult, RevokeTarget, SearchKey, SuppressedCursor } from '../shared/ipc.ts';
import type { AgentStatus, Banner, CostDetail, Cursor, FileItem, HistoryCursor, HistoryFilter, HistoryKey, HistoryRow, LedgerFilter, MapGroup, MapNode, MCursor, ModelMarker, Named, OverlayOp, OverlayResult, Page, PortMessage, PortRequest, SessionDetail, SessionRow, SubagentItem, TCursor, ToolItem, TranscriptAt, TranscriptItem, UsageRecord } from '../shared/ipc.ts';

export interface LiveSet { rows: SessionRow[]; more: boolean }
export interface PortLike { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void; close(): void }
/** delta: the perf-trace id of a sessions push (P3-T10), present only under XAIBO_PERF_TRACE=1. */
export interface Pushes {
  sessions(rows: SessionRow[], delta?: number): void; agents(agents: AgentStatus[] | null): void; coverage?(banners: Banner[]): void;
  /** P4-T10c1: the service dropped a delta too large to send; reload by cursor. */
  resync?(): void;
  /** XAIBO-PROD-595: a catalog import's outcome (after the owner picked a file in main's dialog). */
  catalogImport?(result: CatalogImportResult): void;
}

/** P4-T02: main's window hide/show, forwarded by the preload as `{ xaiboVisible: boolean }`; anything else is null. */
export function parseVisible(x: unknown): boolean | null {
  return isObj(x) && typeof x.xaiboVisible === 'boolean' ? x.xaiboVisible : null;
}

type Reply = Extract<PortMessage, { id: number }>;
/** The reply a request type gets; XAIBO-PROD-579: also a reply whose `type` is a union (connectPreview | connectApply). */
type ReplyOf<T> = Reply extends infer M ? (M extends { type: infer K } ? (T extends K ? M : never) : never) : never;
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
    else if (m.type === 'catalogImport') push.catalogImport?.(m.result);
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
  const ask = <T extends Reply['type']>(body: Body, type: T) => new Promise<ReplyOf<T>>((resolve, reject) => {
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
    /** XAIBO-PROD-586: the whole usage reply (scopes and the per-profile list; Settings' sign-in profiles). */
    async usageAll() { const m = await ask({ type: 'usage' }, 'usage'); return { scopes: m.scopes, profiles: m.profiles }; },
    /** P5-T17a/b: one page of the monthly usage ledger (failed = the store could not answer). */
    async monthly(filter: LedgerFilter, end: string | null, limit: number) {
      const { v: _v, type: _t, id: _i, ...page } = await ask({ type: 'monthly', filter, end, limit }, 'monthly');
      return page;
    },
    /** P5-T16: Clear usage history (after the owner's confirmation). */
    async clearUsage() { return (await ask({ type: 'clearUsage' }, 'clearUsage')).result; },
    /** XAIBO-PROD-590 (P6-T08 slice A): rescan agents and profiles without a restart. */
    async rescan() { return (await ask({ type: 'agentRescan' }, 'agentRescan')).result; },
    /** XAIBO-PROD-598 (P6-T08a slice C): revoke one grant of an imported agent; ids only (granting goes through main). */
    async grantRevoke(agent: string, target: RevokeTarget): Promise<RevokeResult> { return (await ask({ type: 'grantRevoke', agent, target }, 'grantRevoke')).result; },
    // XAIBO-PROD-527 (P5-T18 part 1): history tools and retention/storage settings
    async search(query: string, filter: HistoryFilter, cursor: SearchKey | null, limit: number) {
      const { v: _v, type: _t, id: _i, ...page } = await ask({ type: 'search', query, filter, cursor, limit }, 'search');
      return page;
    },
    async purge(session: number) { return (await ask({ type: 'purge', session }, 'purge')).result; },
    /** XAIBO-PROD-531: one session's history row; null = gone; failed throws (keep the record, offer Retry); a row for
     *  another session throws (design review L2: the parser never sees the request). */
    async historyRow(session: number): Promise<HistoryRow | null> {
      const m = await ask({ type: 'historyRow', session }, 'historyRow');
      if (m.failed) throw new Error('history row unavailable');
      if (m.row && m.row.id !== session) throw new Error('history row for another session');
      return m.row;
    },
    async suppressed(cursor: SuppressedCursor | null, limit: number) {
      const { v: _v, type: _t, id: _i, ...page } = await ask({ type: 'suppressed', cursor, limit }, 'suppressed');
      return page;
    },
    async reimport(key: string) { return (await ask({ type: 'reimport', key }, 'reimport')).result; },
    async retention() { const { setting, lastRunAt } = await ask({ type: 'retention' }, 'retention'); return { setting, lastRunAt }; },
    async setRetention(value: RetentionSetting) { return (await ask({ type: 'setRetention', value }, 'setRetention')).result; },
    /** XAIBO-PROD-568 (P6-T11): Local prices (get, Validate, Reload). */
    async prices(op: PriceOp) { const { view, check } = await ask({ type: 'prices', op }, 'prices'); return { view, check }; },
    async storage(refresh: boolean) { const { report, failed } = await ask({ type: 'storage', refresh }, 'storage'); return { report, failed: failed === true }; },
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
    /** XAIBO-PROD-504 (P5-T01): the history list (pinned first), project and folder pages, and overlay actions. Gate 5
     *  G5b2-5: a page the store could not answer throws (the caller keeps what it shows and offers Retry). */
    async history(filter: HistoryFilter, cursor: HistoryKey | null, limit: number): Promise<{ rows: HistoryRow[]; next: HistoryKey | null }> {
      const m = await ask({ type: 'history', filter, cursor, limit }, 'history');
      if (m.failed) throw new Error('history unavailable');
      return { rows: m.rows, next: m.next };
    },
    async projects(cursor: number | null, limit: number): Promise<{ projects: Named[]; next: number | null }> {
      const m = await ask({ type: 'projects', cursor, limit }, 'projects');
      if (m.failed) throw new Error('projects unavailable');
      return { projects: m.projects, next: m.next };
    },
    async folders(project: number, cursor: number | null, limit: number): Promise<{ folders: Named[]; next: number | null }> {
      const m = await ask({ type: 'folders', project, cursor, limit }, 'folders');
      if (m.failed) throw new Error('folders unavailable');
      return { folders: m.folders, next: m.next };
    },
    /** XAIBO-PROD-510 (P5-T01c): a page of map groups under parent (null = roots); throws when the store could not answer. */
    async mapGroups(parent: MapGroup | null, cursor: MapGroup | null, limit: number): Promise<{ groups: MapNode[]; next: MapGroup | null }> {
      const m = await ask({ type: 'mapGroups', parent, cursor, limit }, 'mapGroups');
      if (m.failed) throw new Error('map groups unavailable');
      return { groups: m.groups, next: m.next };
    },
    /** XAIBO-PROD-575 (P6-T10 unit 2b): one Agents list page, forward from `cursor`; a refusal is a result, not a throw. */
    async integrationPage(cursor: IntegrationKey | null, limit: number): Promise<IntegrationPageResult> {
      return (await ask({ type: 'integrationPage', cursor, direction: 'next', limit }, 'integrationPage')).result;
    },
    /** XAIBO-PROD-578: the integration panel's read; a refusal is a result. */
    async integrationDetail(key: IntegrationKey): Promise<IntegrationDetailResult> { return (await ask({ type: 'integrationDetail', key }, 'integrationDetail')).result; },
    /** XAIBO-PROD-579: the integration panel's previewed writes; a refusal is a result. Connect never asks for the tee (unit 6). */
    async connectPreview(profileId: string, retention: boolean): Promise<ConnectReply> { return (await ask({ type: 'connectPreview', profileId, selections: { retention, tee: false } }, 'connectPreview')).result; },
    async connectApply(previewId: string): Promise<ConnectReply> { return (await ask({ type: 'connectApply', previewId }, 'connectApply')).result; },
    async removalPreview(profileId: string | null): Promise<RemovalReply> { return (await ask({ type: 'removalPreview', profileId }, 'removalPreview')).result; },
    async removalApply(previewId: string): Promise<RemovalReply> { return (await ask({ type: 'removalApply', previewId }, 'removalApply')).result; },
    async cleanupPreview(profileId: string): Promise<CleanupReply> { return (await ask({ type: 'cleanupPreview', profileId }, 'cleanupPreview')).result; },
    async cleanupApply(previewId: string): Promise<CleanupReply> { return (await ask({ type: 'cleanupApply', previewId }, 'cleanupApply')).result; },
    /** XAIBO-PROD-613: a preview of clearing the stale operation lock (applied only through main's confirmation). */
    async lockClearPreview(): Promise<LockClearPreviewReply> { return (await ask({ type: 'lockClearPreview' }, 'lockClearPreview')).result; },
    /** XAIBO-PROD-585 (P6-T10a unit 4a): the sign-in read or one mutation, by profile id and loaded revision; the code is a result. */
    async signIn(profileId: string, command: SignInCommand) { const m = await ask({ type: 'signIn', profileId, ...command }, 'signIn'); return { code: m.code, view: m.view }; },
    /** XAIBO-PROD-581: the separate tee's previews (unit 6a). */
    async teePreview(profileId: string): Promise<ConnectReply> { return (await ask({ type: 'teePreview', profileId }, 'teePreview')).result; },
    async teeRemovalPreview(profileId: string): Promise<RemovalReply> { return (await ask({ type: 'teeRemovalPreview', profileId }, 'teeRemovalPreview')).result; },
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
