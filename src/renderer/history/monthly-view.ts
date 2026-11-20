// XAIBO-PROD-524 (P5-T17b; design §6.1.1, US-20, FR-52): the monthly usage chart's logic. One series per metric; a month
// with no observations or an unavailable value is words with no bar (never an inferred zero); an evidenced zero is 0 with
// a baseline marker; the scale is local to the months shown and starts at zero; cost reads ~$ and says "known subtotal"
// when any request in the month was partly priced, unpriced or pending. Quota peaks stay per usage scope: a current
// scope's label, else a view-local "Scope N" ordinal (never an identity).
import type { LedgerMonth, LedgerQuota } from '../../shared/ipc.ts';
import { costText } from '../model.ts';
import { abbreviate } from '../overview/totals.ts';

export const METRICS = ['tokens', 'cost', 'sessions', 'turns'] as const;
export type Metric = (typeof METRICS)[number];
export const METRIC_LABEL: Record<Metric, string> = { tokens: 'Observed tokens', cost: 'Estimated cost', sessions: 'Sessions', turns: 'Turns' };
const UNIT: Record<Exclude<Metric, 'cost'>, string> = { tokens: 'tokens', sessions: 'sessions', turns: 'turns' };

export type MetricValue = { kind: 'none' | 'unavailable'; text: string } | { kind: 'value'; value: number; text: string; exact: string };

const partly = (c: NonNullable<LedgerMonth['cost']>) => c.partial + c.none + c.pending > 0;
export function metricValue(m: LedgerMonth, metric: Metric): MetricValue {
  if (!m.observed) return { kind: 'none', text: 'No observations' };
  if (metric === 'cost') {
    if (!m.cost || m.cost.usd === null) return { kind: 'unavailable', text: '~$ unavailable' };
    const text = costText(m.cost.usd, partly(m.cost) ? 'partial' : 'full');
    return { kind: 'value', value: m.cost.usd, text, exact: text };
  }
  const v = metric === 'tokens' ? m.tokens?.total ?? null : metric === 'sessions' ? m.sessions : m.turns;
  // Gate 5 G5c-2: requests with missing counts make the total a known subtotal; a 0 subtotal with gaps proves no zero
  const gaps = metric === 'tokens' && (m.tokens?.gaps ?? 0) > 0;
  if (v === null || (gaps && v === 0)) return { kind: 'unavailable', text: 'Unavailable' };
  const sub = gaps ? ' known subtotal' : '';
  return { kind: 'value', value: v, text: `${abbreviate(v)}${sub}`, exact: `${v.toLocaleString('en-US')} ${UNIT[metric]}${sub}` };
}

export const PLOT = 160; // bar plot height inside the 220 px chart (numbers above, months below)
/** Bar heights scaled to the largest value shown; null = no bar (words instead); zero = an evidenced 0 (baseline marker). */
export function bars(months: LedgerMonth[], metric: Metric): { height: number | null; zero: boolean; value: MetricValue }[] {
  const values = months.map((m) => metricValue(m, metric));
  const max = Math.max(0, ...values.map((v) => (v.kind === 'value' ? v.value : 0)));
  return values.map((value) => value.kind !== 'value' ? { height: null, zero: false, value }
    : { height: max === 0 ? 0 : Math.round((value.value / max) * PLOT * 100) / 100, zero: value.value === 0, value });
}

export function scaleCaption(months: LedgerMonth[], metric: Metric): string {
  const values = months.map((m) => metricValue(m, metric)).filter((v) => v.kind === 'value');
  if (!values.length) return 'No values to scale in the months shown';
  const max = Math.max(...values.map((v) => v.value));
  const top = metric === 'cost' ? costText(max, 'full') : `${abbreviate(max)} ${UNIT[metric]}`;
  return `Scale: 0 to ${top} across the months shown`;
}

const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Mar 2026" from YYYY-MM (no locale or time zone involved). */
export const shortMonth = (month: string) => `${NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const DETAIL: Record<LedgerMonth['detail'], string> = { full: '', 'some-expired': 'some details expired', 'totals-only': 'details expired, totals only' };
export function monthLabel(m: LedgerMonth): string {
  return [shortMonth(m.month), m.monthToDate ? 'month to date' : '', DETAIL[m.detail]].filter(Boolean).join(' · ');
}

/** Months per chart page by panel width: at least 80 px each; 12 wide, 6 normal, 3 narrow, 1 below 320 px. */
export function monthsPerPage(width: number): number {
  return width < 320 ? 1 : width < 640 ? 3 : width < 1200 ? 6 : 12;
}

export function windowText(minutes: number | null): string {
  if (minutes === null) return 'Window unknown';
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440} d window`;
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60} h window`;
  return `${minutes} min window`;
}
export function quotaRows(quota: LedgerQuota[]) {
  return quota.map((q) => ({ month: q.month, scope: q.label ?? `Scope ${q.scope}`, limit: q.limitId, window: windowText(q.windowMinutes),
    peak: `${Number(q.peakPercent.toFixed(1))}%`, verified: q.verified ? 'Verified scope' : 'Scope not verified', observations: q.observations }));
}

/** The panel's polite announcement (review M3: a failure is announced too; the one role=status belongs to the health line). */
export function ledgerStatus(s: { loading: boolean; failed: boolean; range: string }): string {
  return s.loading ? 'Loading monthly usage…' : s.failed ? 'Could not load monthly usage' : s.range ? `Showing ${s.range}` : '';
}
