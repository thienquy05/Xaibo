// Session list state (P1-T12): pages and live deltas merged by session id in the service's keyset order. The loaded
// window holds `capacity` rows (a page per Load more); deltas update loaded rows and add new sessions only inside
// that window, trimming from the bottom, so a large backfill never grows the DOM (virtualization is Phase 4).
import { healthText } from '../shared/ipc.ts';
import type { Banner, CostCoverage, Cursor, Health, HealthState, LiveStatus, Page, SessionRow } from '../shared/ipc.ts';
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

/** A replacing page (the first page, or a resynced window of several) sets the window to whole pages around it; a
 * Load more page is merged in and widens the window. */
export function applyPage(s: ListState, page: Page, append: boolean): ListState {
  if (!append) return { rows: merged([], page.rows), next: page.next, capacity: Math.max(PAGE, Math.ceil(page.rows.length / PAGE) * PAGE), loaded: true };
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

/** P4-T04c: the Dashboard's live set (P4-T04a `liveSet`), kept current by session deltas. */
export interface LiveSetState { rows: SessionRow[]; more: boolean; loaded: boolean }
export const emptyLiveSet: LiveSetState = { rows: [], more: false, loaded: false };
export const LIVE_SET_MAX = 100; // the service's cap (api.ts LIVE_SET_MAX)
const member = (r: SessionRow) => r.live !== null && r.live.lifecycle !== 'ended';
/** A delta row that ended or lost its engine status leaves; a live row enters or updates in list order; past `max` the
 *  oldest are trimmed and `more` is set (a resync by `liveSet` restores the exact set). */
export function applyLiveDelta(s: LiveSetState, incoming: SessionRow[], max = LIVE_SET_MAX): LiveSetState {
  const byId = new Map(s.rows.map((r) => [r.id, r]));
  for (const r of incoming) {
    if (member(r)) byId.set(r.id, r);
    else byId.delete(r.id);
  }
  const rows = [...byId.values()].sort(compareRows);
  return rows.length > max ? { ...s, rows: rows.slice(0, max), more: true } : { ...s, rows };
}
/** XAIBO-PROD-448 (G4c-3): members left a capped set (more) and it is below the cap: fetch the set again for the
 *  left-out ones. Cannot loop: the service sets more only when it returns exactly LIVE_SET_MAX rows. */
export const liveSetNeedsRefill = (s: LiveSetState): boolean => s.loaded && s.more && s.rows.length < LIVE_SET_MAX;

/** P4-T04c (design §6.0): the collector's run history for the "Last known" qualifier. Nothing is last known before
 *  the collector first ran; after a loss, the time it stopped running is kept until it runs again. */
export interface Collector { seenRunning: boolean; lostAt: number | null }
export const emptyCollector: Collector = { seenRunning: false, lostAt: null };
/** XAIBO-PROD-436 (owner decision D-P4-09): `paused` is a running service that cannot store (disk full). */
export type BandState = HealthState | 'paused';
export function collectorStep(c: Collector, state: BandState, now: number): Collector {
  if (state === 'running') return { seenRunning: true, lostAt: null };
  if (state === 'paused') return { seenRunning: true, lostAt: c.lostAt ?? now }; // review L: a paused service has run
  return c.seenRunning ? { ...c, lostAt: c.lostAt ?? now } : c;
}
/** The collection band (design §6.0, amended by D-P4-09): a running service that reports disk full reads Paused, never
 *  Running; any other state reads as its health. */
export function bandText(h: Health | null, banners: readonly Banner[]): { state: BandState; text: string } {
  if (!h) return { state: 'starting', text: 'Starting' };
  if (h.state === 'running' && banners.some((b) => b.kind === 'disk-full')) return { state: 'paused', text: 'Paused (disk full)' };
  return { state: h.state, text: healthText(h) };
}
/** null while running (live labels unqualified); otherwise the qualifier text. */
export function lastKnownLabel(c: Collector, state: BandState | null): string | null {
  if (state === 'running') return null;
  return c.seenRunning && c.lostAt !== null ? `since ${formatTime(c.lostAt)}` : 'Collection starting';
}

export function markers(r: SessionRow): string[] {
  const out: string[] = [];
  if (r.drift) out.push('Format drift');
  if (r.compressed) out.push('Compressed, not imported');
  if (r.quarantined > 0) out.push(`${r.quarantined} quarantined line${r.quarantined === 1 ? '' : 's'}`);
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
  if (Number.isNaN(d.getTime())) return 'Unknown'; // P4-T04b2 review: finite but outside the Date range
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
/** Local HH:MM (design §7.1 clock time); unknown is said, never blank. */
export function clock(ms: number | null): string {
  const t = formatTime(ms);
  return t === 'Unknown' ? 'Time unknown' : t.slice(11);
}
/** The clock time when `at` falls on the local day of `now`, else date and time. */
export const shortTime = (at: number, now: number): string =>
  (new Date(at).toDateString() === new Date(now).toDateString() ? clock(at) : formatTime(at));
export const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** Health and last-turn words beside the status badge (design §3.2; full health/ownership presentation is P4-T04). */
export function statusExtras(s: LiveStatus): string[] {
  const out: string[] = [];
  if (s.health === 'stale') out.push('Stale');
  else if (s.health === 'detached') out.push('Health: Detached');
  if (s.outcome) out.push(`Last turn ${s.outcome}`);
  return out;
}

/** §6.4 warning names; a badge never terminates or changes anything. */
const WARNING: Record<LiveStatus['findings'][number], string> = {
  R1: 'Possibly inactive', R2: 'Repeated tool', R3: 'Repeated error', R4: 'Possible loop', R5: 'Long-running tool',
};
export const findingBadges = (s: LiveStatus | null): string[] => (s?.findings ?? []).map((r) => `${r} ${WARNING[r]}`);

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

/** XAIBO-PROD-437 (design §8.1): names for repeated Open session actions, naming each record by agent and folder; an
 *  ordinal ("k of n") only where two records would otherwise read the same. */
export function openSessionLabels(items: readonly { agent: string; place: string }[]): string[] {
  const base = items.map((x) => `Open session: ${x.agent} · ${x.place}`);
  const total = new Map<string, number>();
  for (const b of base) total.set(b, (total.get(b) ?? 0) + 1);
  const seen = new Map<string, number>();
  return base.map((b) => {
    const n = total.get(b)!;
    if (n === 1) return b;
    const k = (seen.get(b) ?? 0) + 1;
    seen.set(b, k);
    return `${b} (${k} of ${n})`;
  });
}

/** XAIBO-PROD-437 (design §5.3/§5.4): the record Return restores: the same one, else the nearest following one (in the
 *  order shown when the user left), else the nearest previous one; null for the view heading. */
export function restoreFocus(current: readonly number[], before: readonly number[], id: number): number | null {
  const here = new Set(current);
  if (here.has(id)) return id;
  const at = before.indexOf(id);
  if (at < 0) return null;
  return before.slice(at + 1).find((x) => here.has(x)) ?? before.slice(0, at).reverse().find((x) => here.has(x)) ?? null;
}

/** XAIBO-PROD-437 (design §8.1): the name of a focusable record row: title · agent · folder, the title cut at 80
 *  characters so a first-prompt title never becomes a whole prompt in a label. */
export function recordLabel(r: Pick<SessionRow, 'title' | 'excerpt' | 'agent' | 'cwd'>): string {
  // XAIBO-PROD-509 (EC-66): an untitled record names its first-prompt excerpt, so repeated Untitled rows differ.
  const title = r.title ? capText(r.title, 80) : r.excerpt ? `Untitled · ${capText(r.excerpt, 80)}` : 'Untitled';
  return `${title} · ${capText(r.agent, 60)} · ${r.cwd ? capText(r.cwd, 120) : 'Unknown folder'}`;
}

/** XAIBO-PROD-437 review L4: untrusted text for a label, at most `n` code points (cut before escaping, so never inside
 *  an escape or a surrogate pair; an ellipsis marks the cut), then visible(). */
export function capText(s: string, n: number): string {
  const a = Array.from(s);
  return a.length > n ? `${visible(a.slice(0, n - 1).join(''))}…` : visible(s);
}
