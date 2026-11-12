// Cost engine (P2-T10, EC-95, PRD §5.12). priceRequest prices one request from its normalized components (T06) with
// the request's model rates: USD = (uncached*in + output*out + cache_read*cr + cache_write*cw) / 1e6; a NULL component,
// an unknown cache-write class or a missing rate is a gap (known subtotal kept); unlisted or unknown price qualifiers
// and an undeterminable tier make the request unavailable; no rates -> unavailable, never 0. priceUsage writes one
// cost_estimates row per request with provenance; a priced row keeps its revision (no repricing), an unavailable one
// is re-evaluated under a new revision. sessionCost selects at read time: an agent-reported session estimate replaces
// the calculated total (never added); a model filter uses only attributable requests (opaque totals never prorated).
import type { DatabaseSync } from 'node:sqlite';
import type { ModelList, Rates } from './models.ts';
import { ratesFor, type PriceRates, type Prices } from './prices.ts';
import type { Completeness } from './tokens.ts';

export interface UsageIn {
  uncachedInput: number | null; cacheRead: number | null; cacheWrite: number | null; cacheWriteClasses: Record<string, number> | null; output: number | null;
  /** Cache write counts toward the prompt size (Claude); Codex and agy input already holds the whole prompt. */
  cacheWriteInPrompt: boolean;
}
/** Reported qualifier values (a present key with null = reported but unknown). */
export type Qualifiers = Record<string, string | null>;
export interface RequestCost { amountUsd: number | null; coverage: 'full' | 'partial' | 'none'; gaps: string[]; applied: Rates | null; reason: string | null }

export function priceRequest(u: UsageIn, r: PriceRates | null, q: Qualifiers, modelId?: string | null): RequestCost {
  const none = (reason: string): RequestCost => ({ amountUsd: null, coverage: 'none', gaps: [], applied: null, reason });
  if (!r) return none(modelId === null ? 'model-unavailable' : 'unpriced-model');
  const listed = r.qualifiers ?? {};
  for (const [k, v] of Object.entries(q)) if (v !== null && !listed[k]?.includes(v)) return none(`unsupported-${k}`);
  for (const k of Object.keys(listed)) if (q[k] === undefined || q[k] === null) return none(`unknown-${k}`);
  // An eligible all-zero request costs exactly 0 at any rate (G2-7: eligibility first).
  if ([u.uncachedInput, u.cacheRead, u.cacheWrite, u.output].every((v) => v === 0)) return { amountUsd: 0, coverage: 'full', gaps: [], applied: r.rates, reason: null };

  let rates = r.rates;
  if (r.tiers?.length) {
    const { uncachedInput: un, cacheRead: cr, cacheWrite: cw } = u;
    if (un === null || cr === null || (u.cacheWriteInPrompt && cw === null)) return none('tier-undetermined');
    const prompt = un + cr + (u.cacheWriteInPrompt ? cw! : 0);
    const tier = [...r.tiers].sort((a, b) => b.above_prompt_tokens - a.above_prompt_tokens).find((t) => prompt > t.above_prompt_tokens);
    if (tier) rates = tier.rates;
  }

  const gaps: string[] = [];
  let sum = 0;
  let priced = false;
  const add = (name: string, tokens: number | null, rate: number | undefined) => {
    if (tokens === 0) priced = true;
    else if (tokens === null || rate === undefined) gaps.push(name);
    else { sum += tokens * rate; priced = true; }
  };
  add('uncached_input', u.uncachedInput, rates.input);
  add('cache_read', u.cacheRead, rates.cache_read);
  if (u.cacheWrite === null) gaps.push('cache_write');
  else if (u.cacheWrite === 0) priced = true;
  else {
    const classes = Object.entries(u.cacheWriteClasses ?? {});
    const ok = u.cacheWriteClasses && classes.reduce((n, [, t]) => n + t, 0) === u.cacheWrite
      && classes.every(([k, t]) => t === 0 || rates.cache_write?.[k] !== undefined);
    if (!ok) gaps.push('cache_write');
    else { for (const [k, t] of classes) if (t) sum += t * rates.cache_write![k]!; priced = true; }
  }
  add('output', u.output, rates.output);
  const coverage = !gaps.length ? 'full' : priced ? 'partial' : 'none';
  return { amountUsd: priced ? sum / 1e6 : null, coverage, gaps, applied: rates, reason: coverage === 'none' ? 'no-priced-component' : null };
}

export interface CostRow {
  basis: 'agent_reported' | 'token_table' | 'owner_fallback'; amountUsd: number | null; coverage: string | null;
  reported: boolean; child: boolean; modelId: string | null;
}
export interface SessionCost { amountUsd: number | null; basis: 'agent_reported' | 'token_table'; coverage: 'full' | 'partial' | 'uncertain' | 'unavailable'; opaqueExcluded: boolean }

export function selectSessionCost(rows: CostRow[], filter?: { modelId?: string }): SessionCost {
  const filtered = filter?.modelId !== undefined;
  const reported = rows.find((r) => r.reported && r.amountUsd !== null);
  if (reported && !filtered) {
    // Inclusion of child work in a reported total is unknown (S13): children are not added, coverage is uncertain.
    return { amountUsd: reported.amountUsd, basis: 'agent_reported', coverage: rows.some((r) => r.child && !r.reported) ? 'uncertain' : 'full', opaqueExcluded: false };
  }
  const requests = rows.filter((r) => !r.reported && (!filtered || r.modelId === filter!.modelId));
  const known = requests.filter((r) => r.amountUsd !== null);
  const opaqueExcluded = filtered && reported !== undefined;
  if (!known.length) return { amountUsd: null, basis: 'token_table', coverage: 'unavailable', opaqueExcluded };
  const amountUsd = known.reduce((n, r) => n + r.amountUsd!, 0);
  return { amountUsd, basis: 'token_table', coverage: requests.every((r) => r.amountUsd !== null && r.coverage === 'full') ? 'full' : 'partial', opaqueExcluded };
}

type UsageRow = {
  sid: number; agent: string; source: string; identity: string; model_id: string | null; uncached_input: number | null; cache_read: number | null;
  cache_write: number | null; cache_write_classes: string | null; output: number | null; raw: string | null; completeness: string | null;
  source_ts: number | null; child: number;
};
const CLAUDE_QUALIFIERS = ['service_tier', 'speed'];
const CODEX_DEFAULT_TIER = 'default';

/** Prices message-scope usage rows without an estimate, or unavailable under an older revision; with afterUsageId only
 *  rows above that usage id (the per-commit pass; start and reloadPrices run the full pass). Returns rows written. */
export function priceUsage(db: DatabaseSync, prices: Prices, o: { afterUsageId?: number } = {}): number {
  const rev = prices.revisionId;
  const rows = db.prepare(`SELECT u.session_id AS sid, s.agent, u.source, u.identity, u.model_id, u.uncached_input, u.cache_read, u.cache_write,
      u.cache_write_classes, u.output, u.raw, u.completeness, u.source_ts, (ev.subagent_native_id IS NOT NULL) AS child
    FROM usage u JOIN sessions s ON s.id = u.session_id LEFT JOIN events ev ON ev.id = u.event_id
    LEFT JOIN cost_estimates e ON e.session_id = u.session_id AND e.covered_scope = 'usage:' || u.source || ':' || u.identity
    WHERE u.scope = 'message' AND (e.id IS NULL OR (e.amount_usd IS NULL AND e.price_revision_id IS NOT ?))
      AND u.id > ?`).all(rev, o.afterUsageId ?? 0) as UsageRow[];
  // G2-2: estimates marked dirty (their evidence changed after pricing) are re-priced with their own revision.
  const dirty = db.prepare(`SELECT u.session_id AS sid, s.agent, u.source, u.identity, u.model_id, u.uncached_input, u.cache_read, u.cache_write,
      u.cache_write_classes, u.output, u.raw, u.completeness, u.source_ts, (ev.subagent_native_id IS NOT NULL) AS child, e.price_revision_id AS ownRev
    FROM cost_estimates e CROSS JOIN usage u ON u.session_id = e.session_id AND u.source = e.source AND u.scope = 'message'
      AND 'usage:' || u.source || ':' || u.identity = e.covered_scope -- G2-17: CROSS JOIN keeps the dirty partial index as the outer loop
    JOIN sessions s ON s.id = u.session_id LEFT JOIN events ev ON ev.id = u.event_id
    WHERE e.dirty = 1`).all() as (UsageRow & { ownRev: number | null })[];
  const seen = new Set(rows.map((u) => `${u.sid}\0${u.source}\0${u.identity}`));
  for (const d of dirty) if (!seen.has(`${d.sid}\0${d.source}\0${d.identity}`)) rows.push(d);
  if (!rows.length) return 0;
  const revTable = db.prepare('SELECT body FROM price_revisions WHERE id = ?');
  const tables = new Map<number, ModelList>();
  const tableOf = (id: number | null | undefined): ModelList => {
    if (id === null || id === undefined || id === rev) return prices.table;
    let t = tables.get(id);
    if (!t) {
      const row = revTable.get(id) as { body: string } | undefined;
      tables.set(id, t = row ? (JSON.parse(row.body) as { table: ModelList }).table : prices.table);
    }
    return t;
  };
  const turnModel = db.prepare(`SELECT model_id FROM turns WHERE session_id = ? AND model_id IS NOT NULL AND started_at <= ?
    ORDER BY started_at DESC, id DESC LIMIT 1`);
  // D-P2-08: the latest explicit thread_settings service_tier at or before the request, else the session's first explicit
  // one (0.160.0 can write thread_settings_applied after the first token_count), else Codex's default tier (S9: rollouts
  // without the key or the event; "default" is the only explicit value observed).
  const codexTiers = db.prepare(`SELECT source_ts AS ts, json_extract(raw, '$.payload.thread_settings.service_tier') AS tier FROM events
    WHERE session_id = ? AND kind = 'settings' AND json_type(raw, '$.payload.thread_settings.service_tier') = 'text' ORDER BY source_ts, id`);
  const tiers = new Map<number, { ts: number | null; tier: string }[]>(); // once per session per pass
  const tierAt = (sid: number, ts: number | null) => {
    let list = tiers.get(sid);
    if (!list) tiers.set(sid, list = codexTiers.all(sid) as { ts: number | null; tier: string }[]);
    const before = ts === null ? [] : list.filter((x) => x.ts !== null && x.ts <= ts);
    return (before.at(-1) ?? list[0])?.tier ?? CODEX_DEFAULT_TIER;
  };
  const put = db.prepare(`INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd, basis, coverage, price_revision_id,
      applied_rates, unavailable_reason, as_of) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id, covered_scope) DO UPDATE SET amount_usd = excluded.amount_usd, basis = excluded.basis, coverage = excluded.coverage,
      price_revision_id = excluded.price_revision_id, applied_rates = excluded.applied_rates, unavailable_reason = excluded.unavailable_reason,
      as_of = excluded.as_of, dirty = 0 WHERE cost_estimates.amount_usd IS NULL OR cost_estimates.dirty = 1`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const u of rows) {
      const ts = u.source_ts;
      const model = u.model_id ?? (ts === null ? null : (turnModel.get(u.sid, ts) as { model_id: string } | undefined)?.model_id ?? null);
      const q: Qualifiers = {};
      if (u.agent === 'claude' && u.raw) {
        const raw = JSON.parse(u.raw) as Record<string, unknown>;
        for (const k of CLAUDE_QUALIFIERS) if (k in raw) q[k] = typeof raw[k] === 'string' ? raw[k] : null;
      } else if (u.agent === 'codex') {
        q.service_tier = tierAt(u.sid, ts);
      }
      const completeness = (u.completeness ? JSON.parse(u.completeness) : {}) as Record<string, Completeness>;
      const own = (u as { ownRev?: number | null }).ownRev;
      const r = ratesFor(tableOf(own), u.agent, model);
      const c = priceRequest({
        uncachedInput: u.uncached_input, cacheRead: u.cache_read, cacheWrite: u.cache_write, output: u.output,
        cacheWriteClasses: u.cache_write_classes ? JSON.parse(u.cache_write_classes) as Record<string, number> : null,
        cacheWriteInPrompt: completeness.cacheWrite === 'reported' || completeness.cacheWrite === 'missing',
      }, r, q, model);
      put.run(u.sid, u.source, `usage:${u.source}:${u.identity}`, c.amountUsd, r?.basis ?? 'token_table',
        JSON.stringify({ coverage: c.coverage, gaps: c.gaps, model, child: u.child === 1 }), own ?? rev, c.applied ? JSON.stringify(c.applied) : null, c.reason, ts);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

/** The session's selected cost (read time). */
export function sessionCost(db: DatabaseSync, sessionId: number | bigint, filter?: { modelId?: string }): SessionCost {
  const rows = (db.prepare('SELECT basis, amount_usd, coverage FROM cost_estimates WHERE session_id = ?').all(sessionId) as
    { basis: CostRow['basis']; amount_usd: number | null; coverage: string | null }[]).map((r) => {
    const c = (r.coverage ? JSON.parse(r.coverage) : {}) as { coverage?: string; model?: string | null; child?: boolean };
    return { basis: r.basis, amountUsd: r.amount_usd, coverage: c.coverage ?? null, reported: r.basis === 'agent_reported', child: c.child === true, modelId: c.model ?? null };
  });
  return selectSessionCost(rows, filter);
}
