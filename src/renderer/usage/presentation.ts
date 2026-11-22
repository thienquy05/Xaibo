// Usage scope presentation (P4-T04b2; design §6.1 usage scopes, §7.1 countdown/freshness, §7.2 C16-C20; PRD §5.11,
// FR-46): derived at render time from the service's raw newest measurement, against the local clock. Nothing here asks
// an agent or provider for anything; a missing value is a phrase, never 0.
import type { UsageScope } from '../../shared/ipc.ts';
import { DAY as D, formatTime, HOUR as H, MIN as M, SEC as S, shortTime } from '../model.ts';
import { visible } from '../text.ts';

export const STALE_MS = 15 * 60_000;
export interface UsageView {
  title: string; value: string; percent: number | null; aboveScale: boolean; reset: string | null; countdown: string | null;
  stale: string | null; /** XAIBO-PROD-435 (design C20): the spoken form of `stale`. */ staleLabel: string | null; freshness: string | null; unverified: boolean; plan: string | null; credits: string | null;
  /** XAIBO-PROD-432 (design §6.13 B4): set while the collector is lost, for a row that shows a reading. */
  lastKnown: string | null;
}

const UNAVAILABLE: Record<string, string> = {
  claude: 'Unavailable — no statusLine quota observation',
  codex: 'Unavailable — no rate-limit observation',
};
function windowTitle(minutes: number | null, stream: string | null): string {
  if (minutes === null) return stream === null ? 'Quota' : visible(stream);
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}
const pct = (p: number) => {
  const r = Math.round(p * 10) / 10;
  return p > 0 && p < 0.1 ? '<0.1%' : p > 100 && r <= 100 ? '>100%' : `${r}%`; // never rounds over-scale to 100 % (review)
};

/** §7.1 countdown: zero leading units omitted, seconds kept; from a day on, seconds dropped. */
export function countdownText(ms: number): string {
  if (ms < S) return 'in <1 s';
  const d = Math.floor(ms / D), h = Math.floor((ms % D) / H), m = Math.floor((ms % H) / M), s = Math.floor((ms % M) / S);
  if (d) return `in ${d} d ${h} h ${m} min`;
  if (h) return `in ${h} h ${m} min ${s} s`;
  return m ? `in ${m} min ${s} s` : `in ${s} s`;
}

interface ReadingLabels<F> { freshness: F; stale: string | null; staleLabel: string | null }
/** Freshness and stale labels of a reading measured at `asOf` (null: source time unknown) and first observed at
 *  `observed` (null: no freshness line); `at` is the time its age counts from. */
export function readingLabels(asOf: number | null, observed: number, at: number | null, stale: boolean): ReadingLabels<string>;
export function readingLabels(asOf: number | null, observed: number | null, at: number | null, stale: boolean): ReadingLabels<string | null>;
export function readingLabels(asOf: number | null, observed: number | null, at: number | null, stale: boolean): ReadingLabels<string | null> {
  return {
    freshness: observed === null ? null
      : asOf !== null ? `Measured ${formatTime(asOf)} · observed ${formatTime(observed)}` : `Source time unknown; observed ${formatTime(observed)}`,
    stale: stale ? `Stale · ${formatTime(at)}` : null,
    staleLabel: stale ? `Stale, last ${asOf !== null ? 'measurement' : 'observation'} ${formatTime(at)}` : null,
  };
}

/** `lastKnown`: the collector-loss label the Dashboard shows (null while collecting); a reading then never reads as current. */
export function usageView(s: UsageScope, now: number, lastKnown: string | null = null): UsageView {
  const empty: UsageView = { title: 'Quota', value: '', percent: null, aboveScale: false, reset: null, countdown: null, stale: null, staleLabel: null, freshness: null,
    unverified: false, plan: null, credits: null, lastKnown: null };
  if (s.unavailable === 'passive') return { ...empty, value: 'Unavailable from passive sources' };
  if (s.unavailable === 'no-observation') return { ...empty, value: UNAVAILABLE[s.agent] ?? 'Unavailable — no observation' };
  const credits = s.credits?.unlimited ? 'Unlimited credits' : s.credits?.balance !== null && s.credits?.balance !== undefined
    ? `Reported credits ${visible(s.credits.balance)}` : s.credits?.hasCredits === false ? 'No credits' : null;
  const measured = s.measuredAt ?? s.firstObservedAt; // review: a reading with no measured time ages from its first observation
  const labels = readingLabels(s.asOf, s.firstObservedAt, measured, measured !== null && now - measured > STALE_MS);
  const base = { ...empty, title: windowTitle(s.windowMinutes, s.stream), freshness: labels.freshness, unverified: s.verified === false, plan: s.plan ? `Plan ${visible(s.plan)}` : null, credits,
    lastKnown: lastKnown === null ? null : `Last known · ${lastKnown}` };
  if (s.resetsAt !== null && now >= s.resetsAt) return { ...base, value: 'Reset passed; awaiting observation' };
  return {
    ...base,
    value: s.usedPercent === null ? 'Utilization unavailable' : pct(s.usedPercent),
    percent: s.usedPercent, aboveScale: s.usedPercent !== null && s.usedPercent > 100,
    reset: s.resetsAt === null ? null : `Resets ${shortTime(s.resetsAt, now)}`,
    countdown: s.resetsAt === null ? null : countdownText(s.resetsAt - now),
    stale: labels.stale, staleLabel: labels.staleLabel,
  };
}

export const HISTORY_DAYS = 45; // fixed observed-history retention (design §6.1)
/** Local day start moved by whole days (calendar arithmetic, so DST days stay one day). */
export function shiftDay(dayStart: number, days: number): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}
/** The local day holding `ms`: [midnight, next midnight) and its YYYY-MM-DD label. */
export function dayRange(ms: number): { from: number; to: number; date: string } {
  const from = shiftDay(ms, 0);
  return { from, to: shiftDay(from, 1), date: formatTime(from).slice(0, 10) };
}
/** First and last day starts the Observed history pager may show: today and the 44 days before it. */
export const historyBounds = (now: number) => ({ first: shiftDay(now, -(HISTORY_DAYS - 1)), last: shiftDay(now, 0) });

export interface ScopeBlock { key: string; agent: string; profile: string; scope: number | null; unverified: boolean; rows: UsageScope[] }
/** One block per scope (or per profile row without a scope); rows are never merged across scopes, so no combined curve
 *  or inferred account total exists (§6.1). Service order kept. */
export function scopeBlocks(scopes: UsageScope[]): ScopeBlock[] {
  const blocks = new Map<string, ScopeBlock>();
  scopes.forEach((s, i) => {
    const key = s.scope === null ? `profile:${s.agent}:${s.profile}:${i}` : `scope:${s.scope}`;
    const b = blocks.get(key);
    if (b) b.rows.push(s);
    else blocks.set(key, { key, agent: s.agent, profile: s.profile, scope: s.scope, unverified: s.verified === false, rows: [s] });
  });
  return [...blocks.values()];
}

/** XAIBO-PROD-436: the usage view reads at most every 5 s, except once right after a first failure (a read pending when
 *  the service restarted fails with its old port; the reconnect's tick retries it at once). Review M: `failures` counts
 *  consecutive failed reads, so a read that keeps failing falls back to the throttle; the retry never overlaps itself. */
export const usageRefreshDue = (last: number, now: number, failures: number, retrying: boolean): boolean =>
  (failures === 1 && !retrying) || now - last >= 5000;
/** XAIBO-PROD-449 (G4c-2): a throttled refresh wakes when the 5 s window ends (the last reading of a burst is fetched
 *  without new activity); a clock moved back never waits longer than 5 s. */
export const usageWakeIn = (last: number, now: number): number => Math.min(5000, Math.max(0, 5000 - (now - last)));
