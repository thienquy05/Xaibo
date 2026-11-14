// Usage scope presentation (P4-T04b2; design §6.1 usage scopes, §7.1 countdown/freshness, §7.2 C16-C20; PRD §5.11,
// FR-46): derived at render time from the service's raw newest measurement, against the local clock. Nothing here asks
// an agent or provider for anything; a missing value is a phrase, never 0.
import type { UsageScope } from '../../shared/ipc.ts';
import { formatTime } from '../model.ts';
import { visible } from '../text.ts';

export const STALE_MS = 15 * 60_000;
export interface UsageView {
  title: string; value: string; percent: number | null; aboveScale: boolean; reset: string | null; countdown: string | null;
  stale: string | null; freshness: string | null; unverified: boolean; plan: string | null; credits: string | null;
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

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
/** §7.1 countdown: zero leading units omitted, seconds kept; from a day on, seconds dropped. */
export function countdownText(ms: number): string {
  if (ms < S) return 'in <1 s';
  const d = Math.floor(ms / D), h = Math.floor((ms % D) / H), m = Math.floor((ms % H) / M), s = Math.floor((ms % M) / S);
  if (d) return `in ${d} d ${h} h ${m} min`;
  if (h) return `in ${h} h ${m} min ${s} s`;
  return m ? `in ${m} min ${s} s` : `in ${s} s`;
}

function resetText(at: number, now: number): string {
  const t = formatTime(at);
  return new Date(at).toDateString() === new Date(now).toDateString() ? `Resets ${t.slice(11)}` : `Resets ${t}`;
}

export function usageView(s: UsageScope, now: number): UsageView {
  const empty: UsageView = { title: 'Quota', value: '', percent: null, aboveScale: false, reset: null, countdown: null, stale: null, freshness: null,
    unverified: false, plan: null, credits: null };
  if (s.unavailable === 'passive') return { ...empty, value: 'Unavailable from passive sources' };
  if (s.unavailable === 'no-observation') return { ...empty, value: UNAVAILABLE[s.agent] ?? 'Unavailable — no observation' };
  const credits = s.credits?.unlimited ? 'Unlimited credits' : s.credits?.balance !== null && s.credits?.balance !== undefined
    ? `Reported credits ${visible(s.credits.balance)}` : s.credits?.hasCredits === false ? 'No credits' : null;
  const freshness = s.firstObservedAt === null ? null
    : s.asOf !== null ? `Measured ${formatTime(s.asOf)} · observed ${formatTime(s.firstObservedAt)}` : `Source time unknown; observed ${formatTime(s.firstObservedAt)}`;
  const base = { ...empty, title: windowTitle(s.windowMinutes, s.stream), freshness, unverified: s.verified === false, plan: s.plan ? `Plan ${visible(s.plan)}` : null, credits };
  if (s.resetsAt !== null && now >= s.resetsAt) return { ...base, value: 'Reset passed; awaiting observation' };
  const measured = s.measuredAt ?? s.firstObservedAt; // review: a reading with no measured time ages from its first observation
  return {
    ...base,
    value: s.usedPercent === null ? 'Utilization unavailable' : pct(s.usedPercent),
    percent: s.usedPercent, aboveScale: s.usedPercent !== null && s.usedPercent > 100,
    reset: s.resetsAt === null ? null : resetText(s.resetsAt, now),
    countdown: s.resetsAt === null ? null : countdownText(s.resetsAt - now),
    stale: measured !== null && now - measured > STALE_MS ? `Stale · ${formatTime(measured)}` : null,
  };
}

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
