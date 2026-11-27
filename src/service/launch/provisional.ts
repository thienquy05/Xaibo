// XAIBO-PROD-622 (P7-T04 slice C, EC-85; design §6.7, OQ-P7-2): provisional launch rows. Main registers a row after a launch
// (started, or failed with its reason); every renderer port gets the list on connect and on each change; a renderer may remove
// a row. Evidence binds a starting row to its session, which then replaces it (the row leaves the list and its session id is
// reported once, so the renderer keeps the focus anchor): an agent launched with a pre-allocated id binds only by that id; one
// without binds only to a stored session that (a) did not exist for that agent and profile when the row was registered, (b)
// started at or after the launch (less a small clock skew), (c) has the launch cwd's normalized key (paths.ts cwdKey: the
// store's own comparison), arriving within BIND_MS of the launch, and only while exactly one such row (still inside BIND_MS)
// waits for that agent, profile and cwd. Store reads fail closed (no snapshot, no stored row: no binding). A row is never ended
// by a timeout (it stays Starting… until bound or removed).
// ponytail: in memory only (a service restart drops the rows; the sessions still appear when evidence arrives); bounded at MAX
// rows, the oldest dropped first. A session known only from hooks has no stored start yet, so a no-id row binds once the
// transcript ingest records it.
import type { ProvisionalRow } from '../../shared/ipc.ts';
import { cwdKey } from '../paths.ts';

export const BIND_MS = 60_000;
const SKEW_MS = 2_000;
const MAX = 32;

export interface StoredSession { id: number; startedAt: number | null; cwdKey: string | null }
export interface ProvisionalDeps {
  now(): number;
  /** Native session ids already stored for this agent and profile (taken at registration); null when the store cannot tell. */
  existing(agent: string, profileId: string): Set<string> | null;
  /** The stored session, null when it is not stored or the store cannot answer. */
  stored(agent: string, profileId: string, nativeSessionId: string): StoredSession | null;
  changed(m: { rows: ProvisionalRow[]; bound: { key: string; session: number }[] }): void;
}

interface Entry { row: ProvisionalRow; key: string; before: Set<string> | null | undefined }

export function provisionalRows(d: ProvisionalDeps) {
  const rows: Entry[] = [];
  const push = (bound: { key: string; session: number }[] = []) => d.changed({ rows: rows.map((r) => r.row), bound });
  return {
    list: (): ProvisionalRow[] => rows.map((r) => r.row),
    register(row: ProvisionalRow): void {
      if (rows.some((r) => r.row.key === row.key)) return;
      const waits = row.nativeId === null && row.state === 'starting';
      rows.push({ row, key: cwdKey(row.cwd), before: waits ? d.existing(row.agent, row.profileId) : undefined });
      if (rows.length > MAX) rows.splice(0, rows.length - MAX);
      push();
    },
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
      if (!e) {
        const now = d.now();
        const fresh = (r: Entry) => same(r) && r.row.nativeId === null && now >= r.row.startedAt && now - r.row.startedAt <= BIND_MS;
        if (!rows.some(fresh)) return;
        s = d.stored(agent, profileId, nativeSessionId);
        if (!s || s.cwdKey === null || s.startedAt === null) return;
        const open = rows.filter((r) => fresh(r) && r.key === s!.cwdKey);
        const r = open.length === 1 ? open[0]! : null; // two waiting launches in one cwd: ambiguous, neither binds
        if (r && r.before && !r.before.has(nativeSessionId) && s.startedAt >= r.row.startedAt - SKEW_MS) e = r;
      }
      if (!e) return;
      s ??= d.stored(agent, profileId, nativeSessionId);
      if (!s) return;
      rows.splice(rows.indexOf(e), 1);
      push([{ key: e.row.key, session: s.id }]);
    },
  };
}
