// XAIBO-PROD-622 (P7-T04 slice C, EC-85; design §6.7, OQ-P7-2): provisional launch rows. Main registers a row before it opens
// Terminal (G7-3, acknowledged) and re-registers its key when the open fails; every renderer port gets the list on connect and on each change; a renderer may remove
// a row. Evidence binds a starting row to its session, which then replaces it (the row leaves the list and its session id is
// reported once, so the renderer keeps the focus anchor): an agent launched with a pre-allocated id binds only by that id; one
// without binds only to a stored session that (a) did not exist for that agent and profile when the row was registered, (b)
// started at or after the launch (less a small clock skew), (c) has the launch cwd's normalized key (paths.ts cwdKey: the
// store's own comparison), arriving within BIND_MS of the launch, and only while exactly one such row (still inside BIND_MS)
// waits for that agent, profile and cwd, and only when it is the one eligible new session stored (G7-4). Store reads fail closed (no snapshot, no stored row: no binding). A row is never ended
// by a timeout (it stays Starting… until bound or removed).
// ponytail: in memory only (a service restart drops the rows; the sessions still appear when evidence arrives); bounded at MAX
// rows, the oldest dropped first. A session known only from hooks has no stored start yet, so a no-id row binds once the
// transcript ingest records it.
import type { ProvisionalRow } from '../../shared/ipc.ts';
import { cwdKey } from '../paths.ts';

export const BIND_MS = 60_000;
const SKEW_MS = 2_000;
const MAX = 32;

export interface StoredSession { id: number; startedAt: number | null; cwdKey: string | null; lastActivity: number | null }
export interface ProvisionalDeps {
  now(): number;
  /** Native session ids already stored for this agent and profile (taken at registration); null when the store cannot tell. */
  existing(agent: string, profileId: string): Set<string> | null;
  /** The stored session, null when it is not stored or the store cannot answer. */
  stored(agent: string, profileId: string, nativeSessionId: string): StoredSession | null;
  /** G7-4 (OQ-P7-2): native ids of stored sessions of this agent and profile in this cwd that started in [from, to); null when the
   *  store cannot tell. */
  fresh(agent: string, profileId: string, cwdKey: string, from: number, to: number): string[] | null;
  changed(m: { rows: ProvisionalRow[]; bound: { key: string; session: number }[] }): void;
}

interface Entry { row: ProvisionalRow; key: string; before: Set<string> | null | undefined }

export function provisionalRows(d: ProvisionalDeps) {
  const rows: Entry[] = [];
  const push = (bound: { key: string; session: number }[] = []) => d.changed({ rows: rows.map((r) => r.row), bound });
  return {
    list: (): ProvisionalRow[] => rows.map((r) => r.row),
    register(row: ProvisionalRow): void {
      const had = rows.find((r) => r.row.key === row.key);
      if (had) { // G7-3: main registers before Terminal opens, then reports a failed open on the same key; nothing else changes a row
        if (had.row.state === 'starting' && row.state === 'failed') { had.row = { ...had.row, state: 'failed', reason: row.reason }; push(); }
        return;
      }
      if (row.state !== 'starting') return; // security review L4: a failed update for a row already removed adds nothing
      const waits = row.nativeId === null;
      rows.push({ row, key: cwdKey(row.cwd), before: waits ? d.existing(row.agent, row.profileId) : undefined });
      if (rows.length > MAX) rows.splice(0, rows.length - MAX);
      push();
    },
    /** G7-1 (OQ-P7-3): a starting row for this session locks it against a second Xaibo resume until it binds, fails or is removed. */
    pending: (agent: string, profileId: string, nativeId: string): boolean =>
      rows.some((r) => r.row.state === 'starting' && r.row.agent === agent && r.row.profileId === profileId && r.row.nativeId === nativeId),
    remove(key: string): void {
      const i = rows.findIndex((r) => r.row.key === key);
      if (i < 0) return;
      rows.splice(i, 1);
      push();
    },
    /** Committed evidence for a session of this agent and profile. */
    offer(agent: string, profileId: string, nativeSessionId: string): void {
      if (!rows.length) return;
      const same = (r: Entry) => r.row.state === 'starting' && r.row.agent === agent && r.row.profileId === profileId;
      let e = rows.find((r) => same(r) && r.row.nativeId === nativeSessionId);
      let s: StoredSession | null = null;
      if (e) { // 627: by id only on activity from the launch on (a resumed session's old records never bind it)
        s = d.stored(agent, profileId, nativeSessionId);
        if (!s || s.lastActivity === null || s.lastActivity < e.row.startedAt - SKEW_MS) return;
      } else {
        const now = d.now();
        const fresh = (r: Entry) => same(r) && r.row.nativeId === null && now >= r.row.startedAt && now - r.row.startedAt <= BIND_MS;
        if (!rows.some(fresh)) return;
        s = d.stored(agent, profileId, nativeSessionId);
        if (!s || s.cwdKey === null || s.startedAt === null) return;
        const open = rows.filter((r) => fresh(r) && r.key === s!.cwdKey);
        const r = open.length === 1 ? open[0]! : null; // two waiting launches in one cwd: ambiguous, neither binds
        // G7-4: exactly one eligible new session (every candidate stored now, in any arrival order), never the first of two
        const cands = r ? d.fresh(agent, profileId, r.key, r.row.startedAt - SKEW_MS, r.row.startedAt + BIND_MS)?.filter((x) => !r.before?.has(x)) : null;
        if (r && r.before && !r.before.has(nativeSessionId) && s.startedAt >= r.row.startedAt - SKEW_MS && cands?.length === 1 && cands[0] === nativeSessionId) e = r;
      }
      if (!e) return;
      s ??= d.stored(agent, profileId, nativeSessionId);
      if (!s) return;
      rows.splice(rows.indexOf(e), 1);
      push([{ key: e.row.key, session: s.id }]);
    },
  };
}
