// DD2 rev 3: presentation geometry only. Existing totals and usage semantics stay in their own modules.
import { LIFECYCLES, type CostCoverage, type SessionRow, type UsageRecord } from '../../shared/ipc.ts';

export interface Datum { label: string; value: number | null; coverage?: CostCoverage; partial?: boolean }
export function tileSeries(rows: SessionRow[], name: (agent: string) => string) {
  // Active agents: distinct agents with a busy (incl. background work), waiting-for-permission or needs-input session.
  // ponytail: agents, not profiles (rows carry no profile); count profiles once a row does.
  const agents = new Map<string, number>();
  for (const r of rows) {
    if (r.live && ['busy', 'waiting-for-permission', 'needs-input'].includes(r.live.lifecycle)) agents.set(r.agent, (agents.get(r.agent) ?? 0) + 1);
  }
  return {
    agents: [...agents].map(([agent, value]) => ({ label: name(agent), value })),
    states: LIFECYCLES.map((label) => ({ label, value: rows.filter((r) => (r.live?.lifecycle ?? 'unknown') === label).length })),
    tokens: rows.map((r, i) => ({ label: `Session ${i + 1}`, value: r.tokens, partial: !r.tokensComplete })),
    cost: rows.map((r, i) => ({ label: `Session ${i + 1}`, value: r.costCoverage === 'unavailable' ? null : r.costUsd, coverage: r.costCoverage })),
  };
}

/** One slim bar per loaded category/session; null leaves its slot empty, zero gets an outline baseline. */
export function barGeometry(values: (number | null)[]) {
  const valid = (v: number | null): v is number => v !== null && Number.isFinite(v) && v >= 0;
  const max = values.reduce<number>((m, v) => valid(v) ? Math.max(m, v) : m, 0);
  const step = 240 / Math.max(values.length, 1);
  return values.map((v, i) => valid(v) ? { x: i * step + step / 4, width: Math.min(12, step / 2), height: max === 0 ? 0 : (v / max) * 40 } : null);
}

export interface Point { x: number; y: number; record: UsageRecord }
/** Scale the loaded range only. Never connect missing minutes, transitions or unevidenced window identity. */
export function historyGeometry(records: UsageRecord[]) {
  const ordered = [...new Map(records.map((r) => [r.id, r])).values()].sort((a, b) => a.measuredAt - b.measuredAt || a.id - b.id);
  const from = ordered[0]?.measuredAt ?? 0, to = ordered.at(-1)?.measuredAt ?? from;
  const maxPercent = ordered.reduce((max, r) => r.usedPercent !== null && Number.isFinite(r.usedPercent) ? Math.max(max, r.usedPercent) : max, 100);
  const points: Point[] = [], segments: Point[][] = [];
  let previous: UsageRecord | null = null;
  for (const r of ordered) {
    if (r.usedPercent === null || !Number.isFinite(r.usedPercent) || r.usedPercent < 0) { previous = null; continue; }
    const point = { x: from === to ? 280 : 40 + ((r.measuredAt - from) / (to - from)) * 480,
      y: 200 - (r.usedPercent / maxPercent) * 180, record: r };
    const adjacent = previous && Math.floor(r.measuredAt / 60_000) - Math.floor(previous.measuredAt / 60_000) === 1;
    const joined = previous !== null && adjacent && r.kind === 'sample' && previous.kind === 'sample' && r.sourceTimeKnown && previous.sourceTimeKnown
      && r.windowMinutes !== null && r.resetsAt !== null && r.windowMinutes === previous.windowMinutes && r.resetsAt === previous.resetsAt;
    if (joined) segments.at(-1)!.push(point);
    else segments.push([point]);
    points.push(point);
    previous = r;
  }
  return { points, segments, from, to, maxPercent };
}

/** A continuous semicircle with neutral space between its track and data; text retains the uncapped percentage. */
export function quotaArc(percent: number | null): string | null {
  if (percent === null || !Number.isFinite(percent) || percent < 0) return null;
  if (percent === 0) return '';
  const angle = Math.PI * Math.min(percent, 100) / 100;
  const x = Math.round((130 - 110 * Math.cos(angle)) * 1000) / 1000;
  const y = Math.round((130 - 110 * Math.sin(angle)) * 1000) / 1000;
  return `M20 130 A110 110 0 0 1 ${x} ${y}`;
}
