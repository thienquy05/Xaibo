// Service coverage banners (P3-T10; EC-12, EC-44, EC-49, EC-25). Hook-only gaps recorded in the last 24 h (spool
// overflow, saturated or torn spool, disk full), grouped by reason and agent; the writer's live disk-full state; and,
// only for profiles where Xaibo hooks are installed (a manifest entry), Claude hooks blocked by managed or user policy
// and Codex hooks awaiting trust with the guided steps. Each profile check is independent: one that fails is skipped.
import type { DatabaseSync } from 'node:sqlite';
import { AGENT_ID, GAP_REASONS, MAX_BANNERS, type Banner } from '../../shared/ipc.ts';
import { claudeHookPolicy, CLAUDE_MANAGED_DIR } from '../adapters/claude/hooks.ts';
import { codexHookStatus } from '../adapters/codex/setup.ts';
import { readManifest, within, type ManifestEntry } from '../config/transaction.ts';

export const GAP_WINDOW_MS = 24 * 3600_000;
export interface CoverageOptions {
  db: DatabaseSync; dataDir: string; profiles: { id: string; agent: string; root: string }[]; diskFull: boolean; now: number;
  /** Claude's managed settings directory (tests pass a temp one). */
  managedDir?: string;
}

/** Everything sent must pass the renderer's parser, or one odd gap row would hide every banner (security review M1):
 *  the disk-full, policy and trust banners come first, gap fields are narrowed to what the parser accepts, the list is
 *  capped at MAX_BANNERS. */
export function coverageBanners(o: CoverageOptions): Banner[] {
  const out: Banner[] = o.diskFull ? [{ kind: 'disk-full' }] : [];
  out.push(...hookBanners(o));
  // count is unknown for the whole group if any member's is (a saturated spool)
  const gaps = o.db.prepare(`SELECT reason, agent, CASE WHEN count(count) = count(*) THEN sum(count) END AS n, min(from_ts) AS f, max(to_ts) AS t
    FROM hook_gaps WHERE recorded_at >= ? GROUP BY reason, agent ORDER BY min(recorded_at) DESC`).all(o.now - GAP_WINDOW_MS) as
    { reason: string; agent: string | null; n: number | null; f: number | null; t: number | null }[];
  const time = (t: number | null) => (t !== null && Number.isSafeInteger(t) && t >= 0 && t <= o.now + GAP_WINDOW_MS ? t : null);
  for (const g of gaps) {
    if (!(GAP_REASONS as readonly string[]).includes(g.reason)) continue;
    out.push({ kind: 'hook-gap', reason: g.reason as typeof GAP_REASONS[number], agent: g.agent !== null && AGENT_ID.test(g.agent) ? g.agent : null,
      count: g.n !== null && Number.isSafeInteger(g.n) && g.n >= 0 ? g.n : null, from: time(g.f), to: time(g.t) });
  }
  return out.slice(0, MAX_BANNERS);
}

function hookBanners(o: CoverageOptions): Banner[] {
  const out: Banner[] = [];
  let manifest: ManifestEntry[];
  try { manifest = readManifest(o.dataDir).filter((e) => e.state === 'applied'); } catch { return out; }
  const installed = (root: string, routes: string[]) => manifest.some((e) => routes.includes(e.route) && within(e.target, root));
  for (const p of o.profiles) {
    try {
      if (p.agent === 'claude' && installed(p.root, ['claude-plugin', 'claude-settings-fallback'])) {
        const policy = claudeHookPolicy({ managedDir: o.managedDir ?? CLAUDE_MANAGED_DIR, configDir: p.root });
        if (policy.state !== 'ok') out.push({ kind: 'hooks-blocked', agent: 'claude', state: policy.state });
      } else if (p.agent === 'codex' && installed(p.root, ['codex-hooks'])) {
        const s = codexHookStatus({ dataDir: o.dataDir, profileKey: p.id, codexHome: p.root, bounds: { root: p.root, denied: [] }, db: o.db });
        if (s.state === 'awaiting-trust') out.push({ kind: 'awaiting-trust', agent: 'codex', steps: s.steps.slice(0, 16).map((x) => x.slice(0, 4096)) });
      }
    } catch { /* this profile's status is unknown; the others still report */ }
  }
  return out;
}
