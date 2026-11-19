// XAIBO-PROD-512 (P5-T04; FR-52): the only path into frozen monthly totals. Every permanent deletion (retention expiry,
// purge, Trash expiry) calls settle() for the records it removes, inside the same transaction, before deleting them.
// A contribution whose key is already settled adds nothing (spool replay, Re-import, suppression-clearing activity);
// a new one adds its share and records its key with the bucket month and offset.
import type { DatabaseSync } from 'node:sqlite';
import { clearedSession, quotaContributions, sessionContributions, Totals } from './monthly.ts';

export interface SettleSelection { sessions: number[]; quota: number[] }

export function settle(db: DatabaseSync, sel: SettleSelection, secret: Buffer, now: number): { added: number; skipped: number } {
  if (!db.isTransaction) throw new Error('settle must run inside the caller\'s transaction');
  const isSettled = db.prepare('SELECT 1 FROM settled_contributions WHERE key = ?');
  const mark = db.prepare('INSERT INTO settled_contributions (key, month, utc_offset, settled_at) VALUES (?, ?, ?, ?)');
  const delta = new Totals();
  const cleared = clearedSession(db); // P5-T16 review M2
  let added = 0, skipped = 0;
  for (const gen of [sessionContributions(db, secret, sel.sessions), quotaContributions(db, secret, sel.quota)]) {
    for (const c of gen) {
      if (isSettled.get(c.key) || cleared(c)) { skipped++; continue; }
      mark.run(c.key, c.at.month, c.at.offset, now); // also dedupes a key repeated within this selection
      delta.add(c);
      added++;
    }
  }
  const revisions = db.prepare('SELECT price_revisions FROM monthly_usage WHERE month = ? AND agent = ? AND profile_key = ? AND model_id = ?');
  const usage = db.prepare(`INSERT INTO monthly_usage (month, agent, profile_key, model_id, sessions, turns, requests, uncached_input, cache_read, cache_write,
      output, token_gaps, cost_micros, cost_full, cost_partial, cost_none, cost_pending, price_revisions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET sessions = sessions + excluded.sessions, turns = turns + excluded.turns, requests = requests + excluded.requests,
      uncached_input = uncached_input + excluded.uncached_input, cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
      output = output + excluded.output, token_gaps = token_gaps + excluded.token_gaps,
      cost_micros = CASE WHEN cost_micros IS NULL THEN excluded.cost_micros WHEN excluded.cost_micros IS NULL THEN cost_micros ELSE cost_micros + excluded.cost_micros END,
      cost_full = cost_full + excluded.cost_full, cost_partial = cost_partial + excluded.cost_partial, cost_none = cost_none + excluded.cost_none,
      cost_pending = cost_pending + excluded.cost_pending, price_revisions = excluded.price_revisions`);
  for (const d of delta.usage.values()) {
    const prior = revisions.get(d.month, d.agent, d.profileKey, d.modelId) as { price_revisions: string } | undefined;
    const revs = [...new Set([...(prior ? JSON.parse(prior.price_revisions) as number[] : []), ...d.priceRevisions])].sort((a, b) => a - b);
    usage.run(d.month, d.agent, d.profileKey, d.modelId, d.sessions, d.turns, d.requests, d.uncachedInput, d.cacheRead, d.cacheWrite, d.output, d.tokenGaps,
      d.costMicros, d.costFull, d.costPartial, d.costNone, d.costPending, JSON.stringify(revs));
  }
  const sessions = db.prepare(`INSERT INTO monthly_sessions (month, agent, profile_key, sessions) VALUES (?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET sessions = sessions + excluded.sessions`);
  for (const d of delta.sessions.values()) sessions.run(d.month, d.agent, d.profileKey, d.sessions);
  const quota = db.prepare(`INSERT INTO monthly_quota_peaks (month, scope_key, limit_id, window_minutes, verified, peak_percent, observations, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET peak_percent = max(peak_percent, excluded.peak_percent), observations = observations + excluded.observations,
      verified = max(verified, excluded.verified)`); // review L7: a scope that became verified stays verified
  for (const d of delta.quota.values()) quota.run(d.month, d.scopeKey, d.limitId, d.windowMinutes ?? -1, d.verified ? 1 : 0, d.peakPercent, d.observations, d.agent);
  return { added, skipped };
}
