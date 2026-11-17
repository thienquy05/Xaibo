// XAIBO-PROD-413 (P4-T05d; design §6.3 as amended by D-P4-06): pure helpers behind the Session workspace components.
import type { CoverageCode, FileItem, LiveStatus, SessionRow, TCursor, ToolItem, TranscriptItem } from '../../shared/ipc.ts';
import { capText, statusExtras } from '../model.ts';
import { statusPresentation, type Tone } from '../status/presentation.ts';
import { approvalText, durationLabel, type Entry } from './timeline.ts';

export type StepTone = 'ok' | 'warn' | 'bad' | 'muted';
/** Status dot of a compact tool row: never ok without evidence of a result. */
export function toolTone(t: ToolItem | null): StepTone {
  if (!t) return 'muted';
  if (t.approval === 'denied' || t.error === true) return 'bad';
  if (t.approval === 'requested') return 'warn';
  return t.error === false ? 'ok' : 'muted'; // review M4: a result without a reported outcome is not success
}
/** Right-hand meta of a tool row: the approval when known, then the duration (or that it is unavailable). */
export function toolMeta(t: ToolItem | null): string[] {
  return [...(t?.approval ? [approvalText(t.approval)] : []), durationLabel(t?.durationMs ?? null)];
}

/** A live session opens on its latest page; anything else at its first turn (design §6.3). */
export const initialAt = (row: Pick<SessionRow, 'live'>): 'first' | 'latest' => (row.live && row.live.lifecycle !== 'ended' ? 'latest' : 'first');
/** XAIBO-PROD-450 (G4d-2; design §6.3): where the list anchors after a transcript load. A replacing load anchors at the
 *  loaded range's start (first) or end (latest); paging keeps the reading position. */
/** XAIBO-PROD-452 (G4d-N1; design §6.3): what the transcript Retry repeats: the request that failed, so a failed page
 *  keeps the window it would have grown and a failed Go to first turn does not load the latest page. */
export const retryRequest = (r: 'first' | 'latest' | 'after' | 'before'): { load: 'first' | 'latest' } | { grow: 'after' | 'before' } =>
  (r === 'first' || r === 'latest' ? { load: r } : { grow: r });
export const loadAnchor = (at: 'first' | 'latest' | 'after' | 'before'): 'start' | 'end' | null => (at === 'first' ? 'start' : at === 'latest' ? 'end' : null);

const MISSING: Partial<Record<CoverageCode, string>> = {
  compressed: 'A transcript file is compressed and not imported',
  quarantined: 'Some records could not be read',
  oversized: 'A record is too large to store',
  'hook-gap': 'Some hook events were lost',
};
/** Why content is incomplete (C13), in coverage order; drift is a separate notice (C25), not missing content. */
export const incompleteReasons = (coverage: readonly CoverageCode[]): string[] => coverage.flatMap((c) => (MISSING[c] ? [MISSING[c]] : []));

/** The file a call touched, as the short argument of its row; null when no file record names it. */
export const argFor = (callId: string | null, touches: readonly FileItem[]): string | null =>
  (callId === null ? null : touches.find((t) => t.callId === callId)?.path ?? null);
/** A section count; `+` when more pages exist than are loaded (never an invented total). */
export const countText = (n: number, more: boolean): string => `${n}${more ? '+' : ''}`;
const two = (n: number) => String(n).padStart(2, '0');
/** P4-T08b: the machine-readable form of a known instant (a <time> dateTime); null when unknown or out of Date range. */
export function isoTime(ms: number | null): string | null {
  const d = new Date(ms ?? Number.NaN);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** XAIBO-PROD-424 (design §5.2/§6.3): what the open conversation does when its session changed. A change during a load
 *  waits for it; a window that reaches the end appends in place; a scrolled-back window offers New activity available
 *  (the anchor never moves); an empty window reloads its initial target. */
export function liveAction(w: { loaded: boolean; loading: boolean; failed?: boolean; next: unknown; items: number; appending?: boolean }): 'later' | 'append' | 'notice' | 'reload' {
  if (w.loading || w.appending) return 'later'; // review M2: one append at a time; a change during it reruns
  // XAIBO-PROD-436 (D-P4-09): a failed window with nothing to show reloads (after a restart the change is the reconnect
  // resync); one that still shows records keeps its anchor and its Retry
  if (w.failed && !w.items) return 'reload';
  if (!w.loaded) return 'later';
  if (w.next !== null) return 'notice';
  return w.items ? 'append' : 'reload';
}

/** XAIBO-PROD-436: a load has settled (loaded or failed); a change held during it runs then. */
export const settled = (w: { loaded: boolean; loading: boolean; failed?: boolean }): boolean => !w.loading && (w.loaded || w.failed === true);

/** XAIBO-PROD-424: the rows of the last delta frame; `resync` counts list resyncs (anything may have changed) and `n`
 *  counts frames. Both are counters, so a delta frame committed after a resync never hides it (review L5). */
export interface SessionChanges { rows: SessionRow[]; resync: number; n: number }

/** Whether the open session changed since the frame last seen (review H1: the frame current at mount is not a change),
 *  and its row from the frame when the frame names it. */
export function openChange(c: SessionChanges, seen: { n: number; resync: number }, id: number): { row: SessionRow | null; bump: boolean } {
  if (c.n === seen.n) return { row: null, bump: false };
  const row = c.rows.find((r) => r.id === id) ?? null;
  return { row, bump: row !== null || c.resync !== seen.resync };
}

/** P4-T09a: a large record's UTF-8 size, decimal units, one decimal (e.g. "52.4 MB", "300.0 KB"). */
export function sizeText(bytes: number): string {
  const kb = (bytes / 1e3).toFixed(1);
  return Number(kb) >= 1000 ? `${(bytes / 1e6).toFixed(1)} MB` : `${kb} KB`; // review L6: 999,999 B reads 1.0 MB
}

/** Local HH:mm (design §7.1 clock time); unknown is said, never blank. */
export function clock(ms: number | null): string {
  if (ms === null) return 'Time unknown';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? 'Time unknown' : `${two(d.getHours())}:${two(d.getMinutes())}`;
}

const DOT: Record<Tone, StepTone | 'busy'> = { accent: 'busy', warning: 'warn', danger: 'bad', success: 'ok', muted: 'muted' };
/** One-line status for compact rows and the header chip (D-P4-06): label, reasons and health/outcome words; the
 *  evidence detail and confidence glyphs stay in the Details drawer's full status. */
export function compactStatus(s: LiveStatus | null): { text: string; tone: StepTone | 'busy' } {
  const p = statusPresentation(s?.lifecycle ?? null, s?.confidence ?? null, s?.reason ? [s.reason] : []);
  return { text: [p.label, ...p.reasons.map((r) => r.label), ...(s ? statusExtras(s) : [])].join(' · '), tone: DOT[p.tone] };
}

/** Review M3 (design §5.2): transcript records kept in memory per open session, 3 pages of 50. */
export const WINDOW_MAX = 150;
/** Keeps the window at WINDOW_MAX records: records appended at the end drop from the start ('end'), records prepended
 *  drop from the end ('start'); the trimmed side gets a keyset cursor at its new edge, so paging continues there. */
export function trimWindow<W extends { items: TranscriptItem[]; prev: TCursor | null; next: TCursor | null }>(w: W, keep: 'end' | 'start', max = WINDOW_MAX): W {
  if (w.items.length <= max) return w;
  if (keep === 'end') {
    const items = w.items.slice(-max);
    return { ...w, items, prev: { seq: items[0]!.seq, id: items[0]!.event } };
  }
  const items = w.items.slice(0, max);
  return { ...w, items, next: { seq: items.at(-1)!.seq, id: items.at(-1)!.event } };
}
/** Re-review: live activity appends at the end but never trims (the reader may be at the top). A window that would
 *  pass WINDOW_MAX keeps its records and gets a cursor at its last record, so "More records available" shows instead. */
export function appendLive<W extends { items: TranscriptItem[]; next: TCursor | null }>(w: W, page: { items: TranscriptItem[]; next: TCursor | null }, max = WINDOW_MAX): W {
  if (w.items.length + page.items.length <= max) return { ...w, items: [...w.items, ...page.items], next: page.next };
  const last = w.items.at(-1);
  return last ? { ...w, next: { seq: last.seq, id: last.event } } : w;
}
/** XAIBO-PROD-451 (G4d-4): a live page appended to a window still ending at `last` (else the window is left alone). An
 *  empty page keeps its continuation cursor: the service returns one when its scan budget meets bookkeeping records. */
export const liveAppend = <W extends { items: TranscriptItem[]; next: TCursor | null }>(w: W, last: TranscriptItem, page: { items: TranscriptItem[]; next: TCursor | null }): W =>
  (w.items.at(-1) === last ? appendLive(w, page) : w);

/** XAIBO-PROD-451 (G4d-3): forward pages from the start, up to `want` pages; null when `live()` turns false (a newer
 *  load superseded it). A rejected page rejects the whole load. */
export async function loadPages<T, C>(fetch: (c: C | null) => Promise<{ items: T[]; next: C | null }>, want: number, live: () => boolean = () => true):
  Promise<{ items: T[]; next: C | null; pages: number } | null> {
  let items: T[] = [];
  let c: C | null = null;
  for (let pages = 1; ; pages++) {
    const p = await fetch(c);
    if (!live()) return null;
    items = [...items, ...p.items];
    if (p.next === null || pages >= want) return { items, next: p.next, pages };
    c = p.next;
  }
}
// ponytail: markers come from the first 10 pages; each page scans at most SCAN_MAX (1,000) turns, so ~10,000 turns.
// Page the markers by the transcript window's range if sessions that long are common.
export const MARKER_PAGES = 10;
export const RELOAD_MAX = 5; // pages refetched per live reload (re-review)

/** Pages a live reload refetches. ponytail: a ledger refetches at most RELOAD_MAX, so pages loaded beyond that drop back on
 *  activity (refresh only the last loaded page if users page that far through busy sessions). A list whose own budget is
 *  above the cap (model markers) keeps every loaded page (XAIBO-PROD-454 review M1), or Load more is undone at once. */
export function reloadPages(pages: number, loaded: number): number {
  return Math.max(pages, pages > RELOAD_MAX ? loaded : Math.min(loaded, RELOAD_MAX));
}

/** XAIBO-PROD-437 (design §8.1): the name of a focusable Conversation/Activity entry: its kind and clock time, never its
 *  content. */
export function entryLabel(e: Entry): string {
  switch (e.kind) {
    case 'prompt': return `Owner prompt · ${clock(e.item.ts)}`;
    case 'response': return `Agent response · ${clock(e.item.ts)}`;
    case 'tool': return `${e.tool?.tool ? `Tool ${capText(e.tool.tool, 60)}` : 'Unknown tool'} · ${clock(e.item?.ts ?? e.tool?.ts ?? null)}`;
    case 'tool-result': return `Tool result · ${clock(e.item.ts)}`;
    case 'large': return `Large record · ${clock(e.item.ts)}`;
    case 'compaction': return `Compaction · ${clock(e.item.ts)}`;
    case 'interrupted': return `Interrupted · ${clock(e.item.ts)}`;
    case 'model': return `Model ${capText(e.marker.model, 60)} · ${clock(e.marker.ts)}`;
    case 'subagent-start': return `Subagent started · ${capText(e.subagent.agentType ?? e.subagent.nativeId, 60)} · ${clock(e.subagent.start)}`;
    case 'subagent-end': return `Subagent ended · ${capText(e.subagent.agentType ?? e.subagent.nativeId, 60)} · ${clock(e.subagent.end)}`;
  }
}
