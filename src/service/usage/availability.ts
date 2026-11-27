// XAIBO-PROD-514 (P5-T06; FR-52, US-20, EC-104): what each month can show. A month exists when it has frozen totals or
// retained contributions (months before the first observation are absent, never zero). Detail availability comes from
// retained records, not age: a month whose settled contributions are all still retained (Keep, active, not yet expired)
// has full detail; some gone → "some details expired"; none retained → "details expired, totals only". Cleared
// contributions (Clear usage history) do not count.
import type { DatabaseSync } from 'node:sqlite';
import { clearedSession, contributions, monthOf } from './monthly.ts';

export type Detail = 'full' | 'some-expired' | 'totals-only';
export interface MonthStatus { month: string; monthToDate: boolean; detail: Detail }

export function monthStatus(db: DatabaseSync, secret: Buffer, now: number): MonthStatus[] {
  const settled = db.prepare('SELECT cleared FROM settled_contributions WHERE key = ?');
  const retained = new Map<string, { all: number; settled: number }>();
  const cleared = clearedSession(db);
  for (const c of contributions(db, secret, { sessions: null, quota: null })) {
    const s = settled.get(c.key) as { cleared: number } | undefined;
    if (s?.cleared === 1 || cleared(c)) continue; // P5-T16 review M2: a per-model key of a cleared session-month too // review: cleared contributions are not shown, retained or not (as in liveMonthly)
    let r = retained.get(c.at.month);
    if (!r) retained.set(c.at.month, r = { all: 0, settled: 0 });
    r.all++;
    if (s) r.settled++;
  }
  const frozen = new Map((db.prepare('SELECT month, count(*) AS n FROM settled_contributions WHERE cleared = 0 GROUP BY month').all() as { month: string; n: number }[])
    .map((r) => [r.month, r.n]));
  // review: a month with frozen totals but no keys (a repair, an older store) is still listed, totals only
  const totals = (db.prepare('SELECT month FROM monthly_usage UNION SELECT month FROM monthly_sessions UNION SELECT month FROM monthly_quota_peaks').all() as { month: string }[])
    .map((r) => r.month);
  const current = monthOf(now).month;
  return [...new Set([...retained.keys(), ...frozen.keys(), ...totals])].sort().map((month) => {
    const r = retained.get(month) ?? { all: 0, settled: 0 };
    const gone = (frozen.get(month) ?? 0) - r.settled;
    return { month, monthToDate: month === current, detail: r.all === 0 ? 'totals-only' : gone > 0 ? 'some-expired' : 'full' };
  });
}
