// Attention queue (P4-T04b2; design §6.2, §7.1): one record per session in fixed groups, oldest onset first with an
// unknown onset last and the service id as tie-break. Heuristic waits are their own group, never confirmed requests.
import type { SessionRow } from '../../shared/ipc.ts';
import { formatTime } from '../model.ts';

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
  for (const r of new Map(rows.map((x) => [x.id, x])).values()) {
    const g = groupOf(r);
    if (g) groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  return GROUPS.filter((g) => groups.has(g)).map((name) => {
    const list = groups.get(name)!.sort(bySince);
    if (name === 'Confirmed requests') list.sort((a, b) => Number(a.live!.lifecycle === 'needs-input') - Number(b.live!.lifecycle === 'needs-input') || bySince(a, b));
    return { name, rows: list };
  });
}

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
/** §7.1 duration: floor units. */
export function durationText(ms: number): string {
  if (ms < S) return '<1 s';
  if (ms < M) return `${Math.floor(ms / S)} s`;
  if (ms < H) return `${Math.floor(ms / M)} min ${Math.floor((ms % M) / S)} s`;
  if (ms < D) return `${Math.floor(ms / H)} h ${Math.floor((ms % H) / M)} min`;
  return `${Math.floor(ms / D)} d ${Math.floor((ms % D) / H)} h`;
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
/** §6.2/§7.1 queue Since: clock (date when another day) plus elapsed duration; a future onset is never negative. */
export function sinceText(since: number | null, now: number): string {
  if (since === null) return 'Since Unknown';
  if (since > now) return `Source clock ahead · ${formatTime(since)}`;
  const clock = sameDay(since, now) ? formatTime(since).slice(11) : formatTime(since);
  return `Since ${clock} · ${durationText(now - since)}`;
}
