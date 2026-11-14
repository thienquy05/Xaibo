// Session list state (P1-T12): pages and live deltas merged by session id in the service's keyset order. The loaded
// window holds `capacity` rows (a page per Load more); deltas update loaded rows and add new sessions only inside
// that window, trimming from the bottom, so a large backfill never grows the DOM (virtualization is Phase 4).
import type { Banner, CostCoverage, Cursor, LiveStatus, Page, SessionRow } from '../shared/ipc.ts';
import { visible } from './text.ts';

export const PAGE = 50;
export interface ListState { rows: SessionRow[]; next: Cursor | null; capacity: number; loaded: boolean }
export const emptyList: ListState = { rows: [], next: null, capacity: PAGE, loaded: false };

/** last activity descending, unknown last, then id ascending (the service's ORDER BY). */
export function compareRows(a: SessionRow, b: SessionRow): number {
  const x = a.lastActivity ?? -Infinity;
  const y = b.lastActivity ?? -Infinity;
  return x !== y ? (y > x ? 1 : -1) : a.id - b.id;
}

const cursorOf = (r: SessionRow): Cursor => ({ lastActivity: r.lastActivity, id: r.id });
const merged = (rows: SessionRow[], incoming: SessionRow[]) => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort(compareRows);
};

/** The first page replaces the list; a Load more page is merged in and widens the window. */
export function applyPage(s: ListState, page: Page, append: boolean): ListState {
  if (!append) return { rows: [...page.rows].sort(compareRows), next: page.next, capacity: PAGE, loaded: true };
  return { rows: merged(s.rows, page.rows), next: page.next, capacity: s.capacity + PAGE, loaded: true };
}

export function applyDelta(s: ListState, incoming: SessionRow[]): ListState {
  const loaded = new Set(s.rows.map((r) => r.id));
  const last = s.rows.at(-1);
  // A session beyond the last loaded row arrives with Load more, unless everything is already loaded.
  const keep = incoming.filter((r) => loaded.has(r.id) || s.next === null || !last || compareRows(r, last) < 0);
  let rows = merged(s.rows, keep);
  let next = s.next;
  if (rows.length > s.capacity) {
    rows = rows.slice(0, s.capacity);
    next = cursorOf(rows.at(-1)!);
  }
  return { ...s, rows, next };
}

export interface Marker { glyph: string; text: string }
export function markers(r: SessionRow): Marker[] {
  const out: Marker[] = [];
  if (r.drift) out.push({ glyph: '⚠', text: 'Format drift' });
  if (r.compressed) out.push({ glyph: '◫', text: 'Compressed, not imported' });
  if (r.quarantined > 0) out.push({ glyph: '⊘', text: `${r.quarantined} quarantined line${r.quarantined === 1 ? '' : 's'}` });
  return out;
}

/** Origin cell (P2-T04, EC-05): the catalog badge, else the raw entry point (visible form) marked unverified, else a
 *  dash; a non-interactive kind adds the "Non-interactive" tag as text. */
export function originText(r: SessionRow): string {
  const base = r.origin ?? (r.entrypoint ? `${visible(r.entrypoint)} (unverified)` : '—');
  return r.interactive === false ? `${base} · Non-interactive` : base;
}

const two = (n: number) => String(n).padStart(2, '0');
/** Local time as YYYY-MM-DD HH:MM; null as "Unknown". */
export function formatTime(ms: number | null): string {
  if (ms === null) return 'Unknown';
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// Live status as placeholder text (P3-T10, Q3-5, before the Gate D design): every state is a glyph plus words, never
// colour alone; confidence is always spelled out, so a heuristic never reads as confirmed (§6.7).
const LIFE: Record<LiveStatus['lifecycle'], Marker> = {
  idle: { glyph: '○', text: 'Idle' }, busy: { glyph: '●', text: 'Busy' }, 'waiting-for-permission': { glyph: '⏸', text: 'Waiting for permission' },
  'needs-input': { glyph: '✎', text: 'Needs input' }, error: { glyph: '✕', text: 'Error' }, ended: { glyph: '■', text: 'Ended' },
  unknown: { glyph: '◌', text: 'Unknown' },
};
export const lifecycleMark = (l: LiveStatus['lifecycle']): Marker => LIFE[l];

export function statusText(s: LiveStatus | null): string {
  if (!s) return 'No live status';
  let t = `${LIFE[s.lifecycle].text}${s.reason ? ` · ${s.reason}` : ''} (${s.confidence})`;
  if (s.health !== 'connected') t += ` · ${s.health}`;
  if (s.outcome) t += ` · last turn ${s.outcome}`;
  return t;
}

/** §6.4 warning names; a badge never terminates or changes anything. */
const WARNING: Record<LiveStatus['findings'][number], string> = {
  R1: 'Possibly inactive', R2: 'Repeated tool', R3: 'Repeated error', R4: 'Possible loop', R5: 'Long-running tool',
};
export const findingBadges = (s: LiveStatus | null): Marker[] => (s?.findings ?? []).map((r) => ({ glyph: '⚠', text: `${r} ${WARNING[r]}` }));

export const contextText = (pct: number | null) => (pct === null ? 'Context unavailable' : `${Math.round(pct)}% context`);

export function costText(usd: number | null, coverage: CostCoverage): string {
  if (usd === null || coverage === 'unavailable') return '~$ unavailable';
  const amount = usd > 0 && usd < 0.005 ? '<0.01' : usd.toFixed(2); // a non-zero estimate never reads as $0.00
  return `~$${amount}${coverage === 'full' ? '' : ' known subtotal'}`;
}

const GAP: Record<Extract<Banner, { kind: 'hook-gap' }>['reason'], string> = {
  'spool-overflow': 'spool overflow', 'spool-saturated': 'spool overflow, count unknown', 'spool-torn': 'damaged spool file', 'disk-full': 'disk full',
};
/** Banner text; `name` maps a catalog agent id to its display name. */
export function bannerText(b: Banner, name: (agent: string) => string): string {
  switch (b.kind) {
    case 'hook-gap': {
      const range = b.from !== null && b.to !== null ? `, ${formatTime(b.from)} to ${formatTime(b.to)}` : '';
      return `Hook events missing (${GAP[b.reason]}): ${b.count ?? 'an unknown number'} from ${b.agent ? visible(name(b.agent)) : 'an unknown agent'}${range}`;
    }
    case 'disk-full': return 'Disk full: collection paused';
    case 'hooks-blocked': return `${visible(name(b.agent))}: ${b.state === 'blocked' ? 'hooks blocked by policy' : 'hook policy unknown'} (files only)`;
    case 'awaiting-trust': return `${visible(name(b.agent))}: hooks installed, awaiting trust`;
  }
}
