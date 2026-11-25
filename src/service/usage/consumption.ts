// XAIBO-PROD-583 (P6-T10a unit 2; design .handoff/p6-t10a-design.md, review R1/R5/R6/R7, D-P6-17): retained observed
// consumption per profile, sign-in generation and Codex account epoch, from stored message-scope usage rows and their
// per-request estimates. One newest-first read of at most `cap` rows (usage-id order); a row's generation is the profile's
// boundary at its trusted source time, else its event's stored generation (writer.ts history(): the quota rule). Observed
// tokens sum the request's components; estimated cost sums per-request estimates only, never an agent-reported session
// total. Coverage is partial on a token gap, a request without a full estimate, a session with a reported total, or the
// cap. The account epoch (a salted HMAC) never leaves the service: a matching verified Codex scope id is the join key.
// ponytail: one global cap, newest rows first, so one busy profile can push others into partial coverage; page per profile
// if that shows up. Database only: no config, credential or environment read.
// ponytail (review L4): writer.ts forces the readings of the event that started a generation into it; a usage row on that
// same event resolves by its own time here (one request per boundary at most); store the forced generation if it matters.
import type { DatabaseSync } from 'node:sqlite';
import type { UsageConsumption } from '../../shared/ipc.ts';
import { notPurging } from '../history/suppression.ts';

export const CONSUMPTION_ROWS = 10_000;
export const MAX_CONSUMPTION = 64;
const SKEW_MS = 5 * 60_000; // as snapshots.sourceTime: a source time this far after its observation is not trusted
type Row = {
  profile_id: string; epoch: string | null; uncached_input: number | null; cache_read: number | null; cache_write: number | null; output: number | null;
  src_ts: number | null; ts: number | null; received: number | null; eg: number; amount_usd: number | null; cov: string | null; reported: number;
};
type Group = UsageConsumption & { epoch: string | null; gap: boolean };

/** `epochs`: migration 027 present (a store left read-only before it counts everything in generation 0). `limited`: the read was
 *  capped (any profile may have older rows); `cut`: profiles with more than MAX_CONSUMPTION groups (the oldest dropped). */
export function consumptionByProfile(db: DatabaseSync, cap = CONSUMPTION_ROWS, epochs = true): { groups: Map<string, UsageConsumption[]>; limited: boolean; cut: Set<string> } {
  const rows = db.prepare(`SELECT s.profile_id, s.account_epoch AS epoch, u.uncached_input, u.cache_read, u.cache_write, u.output, u.source_ts AS src_ts,
      coalesce(u.source_ts, ev.source_ts, ev.received_ts) AS ts, ev.received_ts AS received, ${epochs ? 'coalesce(ev.sign_in_generation, 0)' : '0'} AS eg,
      e.amount_usd, json_extract(e.coverage, '$.coverage') AS cov, (r.id IS NOT NULL) AS reported
    FROM usage u JOIN sessions s ON s.id = u.session_id LEFT JOIN events ev ON ev.id = u.event_id
    LEFT JOIN cost_estimates e ON e.session_id = u.session_id AND e.covered_scope = 'usage:' || u.source || ':' || u.identity
    LEFT JOIN cost_estimates r ON r.session_id = u.session_id AND r.covered_scope = 'session:statusline' AND r.amount_usd IS NOT NULL
    WHERE u.scope = 'message' AND ${notPurging(db)} ORDER BY u.id DESC LIMIT ?`).all(cap + 1) as Row[];
  const limited = rows.length > cap;
  if (limited) rows.length = cap;
  const bounds = new Map<string, { generation: number; at: number }[]>();
  if (epochs) {
    for (const b of db.prepare('SELECT profile_id, generation, at FROM sign_in_boundaries ORDER BY profile_id, generation').all() as { profile_id: string; generation: number; at: number }[]) {
      bounds.set(b.profile_id, [...(bounds.get(b.profile_id) ?? []), { generation: b.generation, at: b.at }]);
    }
  }
  const genAt = (profile: string, t: number) => (bounds.get(profile) ?? []).reduce((g, b) => (b.at <= t && b.generation > g ? b.generation : g), 0);
  const scopeOf = db.prepare(`SELECT id FROM usage_scopes WHERE profile_id = ? AND agent = 'codex' AND epoch = ? AND verified = 1${epochs ? ' AND sign_in_generation = ?' : ''}`);
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const trusted = r.src_ts !== null && r.received !== null && r.src_ts <= r.received + SKEW_MS;
    const generation = trusted ? genAt(r.profile_id, r.src_ts!) : r.eg;
    const key = `${r.profile_id}|${generation}|${r.epoch ?? ''}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { generation, scope: null, tokens: null, estimatedUsd: null, coverage: 'full', from: null, to: null, limited, epoch: r.epoch, gap: false });
    const parts = [r.uncached_input, r.cache_read, r.cache_write, r.output];
    for (const p of parts) if (p !== null) g.tokens = (g.tokens ?? 0) + p;
    const full = r.amount_usd !== null && r.cov === 'full'; // review M1: any per-request basis (token table or owner fallback)
    if (r.amount_usd !== null) g.estimatedUsd = (g.estimatedUsd ?? 0) + r.amount_usd;
    if (parts.includes(null) || !full || r.reported) g.gap = true;
    const at = trusted ? r.src_ts : r.received ?? r.ts; // review L6: an untrusted source time never stretches the interval
    if (at !== null) { g.from = g.from === null ? at : Math.min(g.from, at); g.to = g.to === null ? at : Math.max(g.to, at); }
  }
  const out = new Map<string, UsageConsumption[]>(), cut = new Set<string>();
  for (const [key, g] of groups) {
    const profile = key.slice(0, key.indexOf('|'));
    const scope = g.epoch === null ? null : (scopeOf.get(...(epochs ? [profile, g.epoch, g.generation] : [profile, g.epoch])) as { id: number } | undefined)?.id ?? null;
    const list = out.get(profile) ?? [];
    if (list.length >= MAX_CONSUMPTION) { cut.add(profile); continue; } // review L5: newest groups first; the oldest dropped, said
    list.push({ generation: g.generation, scope, tokens: g.tokens, estimatedUsd: g.estimatedUsd, coverage: g.gap || limited ? 'partial' : 'full', from: g.from, to: g.to, limited });
    out.set(profile, list);
  }
  return { groups: out, limited, cut };
}
