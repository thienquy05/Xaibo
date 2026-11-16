// XAIBO-PROD-413 (P4-T05d; design §6.3 as amended by D-P4-06): pure helpers behind the Session workspace components.
import type { CoverageCode, FileItem, LiveStatus, SessionRow, TCursor, ToolItem, TranscriptItem } from '../../shared/ipc.ts';
import { statusExtras } from '../model.ts';
import { statusPresentation, type Tone } from '../status/presentation.ts';
import { approvalText, durationLabel } from './timeline.ts';

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
/** Local HH:mm (design §7.1 clock time); unknown is said, never blank. */
/** P4-T08b: the machine-readable form of a known instant (a <time> dateTime); null when unknown or out of Date range. */
export function isoTime(ms: number | null): string | null {
  const d = new Date(ms ?? Number.NaN);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

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
