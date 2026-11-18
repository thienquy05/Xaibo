// Live-set summary (P4-T04b2; design §6.1, §7.1 D1, PRD §5.12): totals over the service's live set (P4-T04a). A total
// with no known member is unavailable (null), never 0; a total missing members or carrying an incomplete one is a
// known subtotal; each session counts once by id; eligible coverage below 80 % is flagged, never imputed.
import type { SessionRow } from '../../shared/ipc.ts';

export interface Coverage { observed: number; eligible: number; partial: boolean; low: boolean }
export interface Summary {
  /** Members of the live set; `atLeast` when the service capped it (more exist). */
  sessions: number; atLeast: boolean;
  /** Distinct agents with a busy (incl. background work), waiting-for-permission or needs-input session.
   *  ponytail: agents, not profiles (rows carry no profile); count profiles once a row does. */
  activeAgents: number;
  tokens: { value: number | null } & Coverage;
  cost: { usd: number | null; priced: number; eligible: number; partial: boolean; low: boolean };
}

const ACTIVE = new Set(['busy', 'waiting-for-permission', 'needs-input']);
const low = (n: number, of: number) => of > 0 && n / of < 0.8;
/** A sum that overflowed is unavailable, never Infinity (P4-T04b2 security review). `partial` describes a known value only. */
const finite = (v: number | null) => (v !== null && Number.isFinite(v) ? v : null);

export function liveSetSummary(rows: SessionRow[], more: boolean): Summary {
  const members = [...new Map(rows.map((r) => [r.id, r])).values()];
  const n = members.length;
  const counted = members.filter((r) => r.tokens !== null);
  const priced = members.filter((r) => r.costUsd !== null && r.costCoverage !== 'unavailable');
  return {
    sessions: n, atLeast: more,
    activeAgents: new Set(members.filter((r) => r.live && ACTIVE.has(r.live.lifecycle)).map((r) => r.agent)).size,
    tokens: {
      value: finite(counted.length ? counted.reduce((s, r) => s + r.tokens!, 0) : null),
      observed: counted.length, eligible: n, partial: counted.length > 0 && (counted.length < n || counted.some((r) => !r.tokensComplete)), low: low(counted.length, n),
    },
    cost: {
      usd: finite(priced.length ? priced.reduce((s, r) => s + r.costUsd!, 0) : null),
      priced: priced.length, eligible: n, partial: priced.length > 0 && (priced.length < n || priced.some((r) => r.costCoverage !== 'full')), low: low(priced.length, n),
    },
  };
}

const UNITS: [number, string][] = [[1e3, 'k'], [1e6, 'M'], [1e9, 'B'], [1e12, 'T']];
/** D1: below 1,000 the full integer; else one decimal half up with trailing .0 dropped, promoted when rounding reaches
 *  1,000 of a unit (999,950 -> 1M). */
export function abbreviate(n: number): string {
  if (n < 1000) return String(Math.round(n));
  let out = '';
  for (const [size, unit] of UNITS) {
    const v = Math.round((n / size) * 10) / 10;
    out = `${v}${unit}`;
    if (v < 1000) break;
  }
  return out;
}
