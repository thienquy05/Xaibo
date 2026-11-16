// XAIBO-PROD-414 (P4-T06a; PRD FR-47, US-17; design §6.3.1, §7.1 D1): the Current context view from the newest
// generation's latest reading. The service keeps used and window in one generation (no old numerator over a new
// window); this module only presents: abbreviated visible values, exact integers in accessible text, a meter only for
// an in-range reading, Awaiting next usage after compaction, and unavailable (never 0) for anything not reported.
import type { ContextReading } from '../../../shared/ipc.ts';
import { formatTime } from '../../model.ts';
import { abbreviate } from '../../overview/totals.ts';
import { STALE_MS } from '../../usage/presentation.ts';

export interface ContextView {
  value: string; qualifier: string | null;
  /** Used share 0–100 for the meter; null replaces the meter with meterNote. */
  meter: number | null; meterNote: string | null; warning: string | null; unoccupied: string | null;
  source: string; freshness: string; stale: string | null; generation: string;
  /** Accessible text: exact integers, percent, estimate state, source and generation. */
  label: string;
}

const SOURCE: Record<ContextReading['source'], string> = {
  transcript: 'Claude transcript', statusline: 'Claude statusLine', compaction: 'Compaction record', rollout: 'Codex rollout',
};
const exact = (n: number) => n.toLocaleString('en-US');

/** §7.1 Context: one decimal, trailing .0 dropped; a nonzero value below 0.1 reads <0.1%, never a forced 0. */
export function percentText(p: number): string {
  return p > 0 && p < 0.1 ? '<0.1%' : `${Math.round(p * 10) / 10}%`;
}
const percentWords = (p: number) => percentText(p).replace('<', 'less than ').replace('%', ' percent');

function unavailable(reason: string): ContextView {
  return { value: 'Context unavailable', qualifier: null, meter: null, meterNote: `Context meter unavailable — ${reason}`, warning: null, unoccupied: null,
    source: 'Source unavailable', freshness: 'No observation', stale: null, generation: 'Generation unavailable', label: `Context unavailable: ${reason}` };
}

export function contextView(agent: string, live: boolean, r: ContextReading | null, now: number): ContextView {
  if (agent === 'agy') return unavailable('Antigravity CLI context inputs and window are unverified');
  if (r === null) return unavailable('no context reading from this source');
  const at = r.asOf ?? r.observedAt;
  const base = {
    qualifier: null, meter: null, meterNote: null, warning: null, unoccupied: null,
    source: `Source: ${SOURCE[r.source]}`,
    freshness: r.asOf !== null ? `Measured ${formatTime(r.asOf)} · observed ${formatTime(r.observedAt)}` : `Source time unknown; observed ${formatTime(r.observedAt)}`,
    stale: live && now - at > STALE_MS ? `Stale · ${formatTime(at)}` : null,
    generation: `Generation ${r.generation + 1}`,
  };
  const est = r.basis === 'inferred' ? '~est ' : '';
  const head = r.basis === 'inferred' ? 'Context, estimate: ' : 'Context: ';
  const tail = `; source ${SOURCE[r.source]}; generation ${r.generation + 1}`;
  const { used, window } = r;
  if (used === null && window !== null && r.source !== 'compaction') { // keep the evidenced window on its own (§6.3.1)
    return { ...base, value: `${est}Used unavailable · ${abbreviate(window)} window`, meterNote: 'Context meter unavailable — used tokens not reported',
      label: `${head}used tokens unavailable; window ${exact(window)} tokens${tail}` };
  }
  if (used === null) {
    const compacted = r.source === 'compaction';
    return { ...base, value: compacted ? 'Awaiting next usage' : 'Context unavailable',
      meterNote: `Context meter unavailable — ${compacted ? 'awaiting next usage after compaction' : 'used tokens not reported'}`,
      label: `${head}${compacted ? 'awaiting next usage after compaction' : 'used tokens unavailable'}${tail}` };
  }
  if (window === null) {
    return { ...base, value: `${est}${abbreviate(used)} used · window unavailable`,
      meterNote: `Context meter unavailable — window not reported${agent === 'claude' ? ' (no statusLine window yet)' : ''}`,
      label: `${head}percentage unavailable; ${exact(used)} tokens used; window unavailable${tail}` };
  }
  const pct = window > 0 ? (used * 100) / window : null;
  const pctText = pct === null ? '' : `${percentText(pct)} · `;
  const value = `${est}${pctText}${abbreviate(used)} / ${abbreviate(window)}`;
  if (pct === null || used > window) {
    return { ...base, value, warning: `Reading out of range: ${exact(used)} of ${exact(window)} tokens`, meterNote: 'Context meter unavailable — reading out of range',
      label: `${head}${pct === null ? '' : `${percentWords(pct)}; `}${exact(used)} of ${exact(window)} tokens, out of range${tail}` };
  }
  const interim = r.source === 'compaction';
  return { ...base, value, meter: pct, unoccupied: 'Unoccupied; buffer unknown', qualifier: interim ? 'Interim after compaction' : null,
    label: `${head}${percentWords(pct)}; ${exact(used)} of ${exact(window)} tokens${interim ? '; interim after compaction' : ''}${tail}` };
}

export interface CategoryRow { group: string; name: string; value: string; label: string }
const V1B = 'unavailable — composition estimates arrive in v1-B';
const cat = (group: string, name: string, label = `${name}: ${V1B}`): CategoryRow => ({ group, name, value: 'Unavailable', label });
/** §6.3.1 D2: rows always present; composition estimates are v1-B, so every value is unavailable in the MVP. */
export const CATEGORY_ROWS: CategoryRow[] = [
  ...['Messages', 'System prompt', 'Memory files', 'Skills', 'MCP server instructions', 'System tool definitions', 'MCP tool definitions',
    'Custom agents'].map((n) => cat('Used context', n)),
  cat('Outside used context', 'Compaction buffer'),
  cat('Outside used context', 'Free space', 'Free space: unavailable — compaction buffer unavailable'),
  cat('Deferred definitions', 'Deferred MCP tool definitions'),
  cat('Deferred definitions', 'Deferred system tool definitions'),
];
