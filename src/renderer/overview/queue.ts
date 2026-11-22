// Attention queue (P4-T04b2; design §6.2, §7.1): one record per session in fixed groups, oldest onset first with an
// unknown onset last and the service id as tie-break. Heuristic waits are their own group, never confirmed requests.
import type { SessionRow } from '../../shared/ipc.ts';
import { DAY as D, formatTime, HOUR as H, MIN as M, SEC as S, shortTime } from '../model.ts';

export const GROUPS = ['Confirmed requests', 'Errors', 'Unconfirmed requests', 'Probably waiting', 'Findings'] as const;
export type GroupName = typeof GROUPS[number];
export interface Group { name: GroupName; rows: SessionRow[] }

const WAITS = new Set(['waiting-for-permission', 'needs-input']);
function groupOf(r: SessionRow): GroupName | null {
  const l = r.live;
  if (!l) return null;
  if (WAITS.has(l.lifecycle)) return l.confidence === 'confirmed' ? 'Confirmed requests' : l.confidence === 'inferred' ? 'Unconfirmed requests' : 'Probably waiting';
  if (l.lifecycle === 'error') return 'Errors';
  return l.findings.length ? 'Findings' : null;
}

const bySince = (a: SessionRow, b: SessionRow) => {
  const x = a.live?.since ?? Infinity, y = b.live?.since ?? Infinity;
  return x !== y ? (x < y ? -1 : 1) : a.id - b.id;
};
/** Confirmed requests list permission waits before input waits (§6.2); every group is oldest first. */
export function attentionQueue(rows: SessionRow[]): Group[] {
  const groups = new Map<GroupName, SessionRow[]>();
  for (const r of rows) {
    const g = groupOf(r);
    if (g) groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  return GROUPS.filter((g) => groups.has(g)).map((name) => {
    const list = groups.get(name)!.sort(bySince);
    if (name === 'Confirmed requests') list.sort((a, b) => Number(a.live!.lifecycle === 'needs-input') - Number(b.live!.lifecycle === 'needs-input') || bySince(a, b));
    return { name, rows: list };
  });
}

/** XAIBO-PROD-448 (G4c-4; design §6.13 A2): the attention view before the live set first loads is loading, or failed
 *  after that load failed; once loaded it lists its groups, or the empty message, and keeps them on a later failure. */
export const attentionState = (loaded: boolean, failed: boolean, groups: number): 'loading' | 'failed' | 'empty' | 'queue' =>
  !loaded ? (failed ? 'failed' : 'loading') : groups ? 'queue' : 'empty';

/** §7.1 duration: floor units. */
export function durationText(ms: number): string {
  if (ms < S) return '<1 s';
  if (ms < M) return `${Math.floor(ms / S)} s`;
  if (ms < H) return `${Math.floor(ms / M)} min ${Math.floor((ms % M) / S)} s`;
  if (ms < D) return `${Math.floor(ms / H)} h ${Math.floor((ms % H) / M)} min`;
  return `${Math.floor(ms / D)} d ${Math.floor((ms % D) / H)} h`;
}

/** §6.2/§7.1 queue Since: clock (date when another day) plus elapsed duration; a future onset is never negative. */
export function sinceText(since: number | null, now: number): string {
  if (since === null) return 'Since Unknown';
  if (since > now) return `Source clock ahead · ${formatTime(since)}`;
  return `Since ${shortTime(since, now)} · ${durationText(now - since)}`;
}

/** XAIBO-PROD-437 review M1: the session ids in the order a Dashboard view lists their Open session buttons (from data,
 *  so rows a virtual list has not mounted still count). */
export function openOrder(view: 'live' | 'attention' | 'usage', rows: SessionRow[]): number[] {
  if (view === 'live') return rows.map((r) => r.id);
  return view === 'attention' ? attentionQueue(rows).flatMap((g) => g.rows.map((r) => r.id)) : [];
}
