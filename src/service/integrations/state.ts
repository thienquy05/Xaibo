// XAIBO-PROD-574 (P6-T10 unit 2a; FR-06, D-P6-11; design .handoff/p6-t10-design.md section 1 "Derive FR-06", review
// R2/R3/R7/R10): the Agent Map Agents list. One row per catalog agent and profile; the state comes from executable
// detection, the version qualification, a fresh read-only reconcile, Claude hook policy, Codex trust and the last
// lifecycle receipt, in the design's order, each with named reasons. Nothing runs; the only write is the existing Codex
// observation record codexHookStatus keeps (as the coverage banners do; code review M1).
import type { DatabaseSync } from 'node:sqlite';
import { GAP_REASONS, INTEGRATION_PAGE_MAX, type IntegrationFact, type IntegrationKey, type IntegrationPageResult, type IntegrationRow,
  type IntegrationState } from '../../shared/ipc.ts';
import { CLAUDE_HOOK_EVENTS, claudeHookPolicy } from '../adapters/claude/hooks.ts';
import { CODEX_HOOK_EVENTS } from '../adapters/codex/hooks.ts';
import { codexHookStatus } from '../adapters/codex/setup.ts';
import { profileLabel } from '../api.ts';
import type { Detection, Profile } from '../catalog/detect.ts';
import type { Catalog } from '../catalog/validate.ts';
import { readManifest, within, type ManifestEntry } from '../config/transaction.ts';
import { GAP_WINDOW_MS } from '../status/coverage.ts';
import type { ReconcileReport, ReconcileState } from './reconcile.ts';

const LIFECYCLE_ROUTES = new Set(['claude-plugin', 'claude-settings-fallback', 'codex-hooks', 'agy-hooks']);
const MAX_CANDIDATES = 4096;
/** Review R3: content coverage from the adapters Xaibo ships (the evidence that verified each); anything else unavailable. */
const CONTENT: Record<string, string> = { claude: 'S9', codex: 'S9', agy: 'P2-T00' };
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

export interface StateInput {
  agent: string;
  detection: { state: 'detected'; version: string | null } | { state: 'not-detected'; reason?: 'probe-not-granted' | 'probe-grant-stale' };
  /** The version is qualified for the agent's Connect routes (true when the catalog states none). */
  qualified: boolean; profile: boolean;
  /** States of the profile's lifecycle manifest entries in a fresh reconcile; unavailable when the reconcile was blocked. */
  entries: ReconcileState[] | 'unavailable';
  blocked: boolean; trust: 'awaiting-trust' | 'connected' | null; receipt: boolean; gaps: string[]; content: 'verified' | 'unavailable';
}

/** FR-06 in the design's order (section 1, steps 1-8). Reconcile `connected` only means the owned config is intact. */
export function deriveState(i: StateInput): { state: IntegrationState; reasons: IntegrationFact[] } {
  const r = (state: IntegrationState, reasons: IntegrationFact[] = []) => ({ state, reasons });
  if (i.detection.state === 'not-detected') return r('not-detected', [i.detection.reason ?? 'no-executable']);
  if (i.detection.version === null) return r('unsupported-version', ['version-unknown']);
  if (!i.qualified) return r('unsupported-version', ['version-unqualified']);
  if (!i.profile) return r('detected', ['no-profile']);
  if (i.entries === 'unavailable') return r('setup-required', ['evidence-unavailable']);
  if (i.entries.length === 0) return r('detected', ['not-connected']);
  const broken = [...new Set(i.entries.filter((s) => s !== 'connected'))] as IntegrationFact[];
  if (broken.length) return r('setup-required', broken);
  if (i.blocked) return r('setup-required', ['hooks-blocked']);
  if (i.trust === 'awaiting-trust') return r('awaiting-trust', ['no-receipt']);
  if (!i.receipt && i.trust !== 'connected') return r('setup-required', ['waiting-for-receipt']);
  const limits: IntegrationFact[] = [...(i.gaps.length ? ['hook-gap' as const] : []), ...(i.content === 'unavailable' ? ['content-unavailable' as const] : [])];
  return limits.length ? r('partial-coverage', limits) : r('connected');
}

/** Review R2/R7: the newest attributed delivery with a native session whose event is in the agent's lifecycle set, received
 *  after the integration was installed (`since`); none before an install. */
export function lastReceipt(db: DatabaseSync, agent: string, profileId: string, since: number | null, events: readonly string[] = lifecycleEvents(agent, null)): IntegrationRow['receipt'] {
  if (since === null || events.length === 0) return null;
  const list = JSON.stringify(events);
  const r = db.prepare(`SELECT source, event, received_ts AS at FROM (
      SELECT 'hook' AS source, event, received_ts FROM hook_delivery WHERE agent = ?1 AND profile_key = ?2 AND received_ts > ?3
        AND native_session_id IS NOT NULL AND unattributed IS NULL AND event IN (SELECT value FROM json_each(?4))
      UNION ALL
      SELECT 'report', event, received_ts FROM report_delivery WHERE agent = ?1 AND profile_key = ?2 AND received_ts > ?3
        AND unattributed IS NULL AND event IN (SELECT value FROM json_each(?4)))
    ORDER BY received_ts DESC LIMIT 1`).get(agent, profileId, since, list) as { source: 'hook' | 'report'; event: string; at: number } | undefined;
  return r ? { source: r.source, event: r.event, receivedAt: r.at } : null;
}

function lifecycleEvents(agent: string, catalog: Catalog | null): readonly string[] {
  if (agent === 'claude') return CLAUDE_HOOK_EVENTS;
  if (agent === 'codex') return CODEX_HOOK_EVENTS;
  return catalog?.agents.find((a) => a.id === agent)?.hookMappings?.rules.map((x) => x.event) ?? [];
}

/** Claude's Connect routes qualify an exact release at or above a min (and up to a max); agents without routes need only a
 *  known version. A prerelease is never qualified (D-P6-07). */
function qualified(catalog: Catalog | null, agent: string, version: string): boolean {
  const routes = catalog?.agents.find((a) => a.id === agent)?.connectRoutes;
  if (!routes?.length) return true;
  const v = RELEASE.exec(version);
  if (!v) return false;
  const n = (s: string) => s.split('.').map(Number);
  const cmp = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  const x = [Number(v[1]), Number(v[2]), Number(v[3])];
  return routes.some((r) => cmp(x, n(r.versions.min)) >= 0 && (r.versions.max === undefined || cmp(x, n(r.versions.max)) <= 0));
}

export interface PageDeps {
  db: DatabaseSync; catalog: Catalog | null; detections: readonly Detection[]; profiles: readonly Profile[] | null; home: string; now: number;
  /** A fresh read-only reconcile; null when the Connect core is not built yet. */
  reconcile(): ReconcileReport | null;
  /** When the profile's current lifecycle integration was installed (its newest applied entry), or null. */
  installedAt(p: Profile): number | null;
  trust(p: Profile): 'awaiting-trust' | 'connected' | null;
  /** Claude only: 'blocked' or 'unknown' hook policy, else null. */
  policy(p: Profile): string | null;
}

const order = (k: IntegrationKey) => k.agent + '|' + (k.profileId ?? ''); // agent ids hold no '|'

function rows(d: PageDeps): IntegrationRow[] {
  const report = d.reconcile();
  // code review M3: a gap recorded without an agent (a spool that could not tell) limits every agent
  const gapsOf = (agent: string) => (d.db.prepare('SELECT DISTINCT reason FROM hook_gaps WHERE (agent = ? OR agent IS NULL) AND recorded_at >= ? ORDER BY reason')
    .all(agent, d.now - GAP_WINDOW_MS) as { reason: string }[]).map((g) => g.reason).filter((g): g is (typeof GAP_REASONS)[number] => (GAP_REASONS as readonly string[]).includes(g));
  const out: IntegrationRow[] = [];
  for (const a of [...(d.catalog?.agents ?? [])].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const det = d.detections.find((x) => x.agent === a.id) ?? { agent: a.id, state: 'not-detected' as const };
    const detection = det.state === 'detected' ? { state: 'detected' as const, version: det.version } : { state: 'not-detected' as const, ...(det.reason ? { reason: det.reason } : {}) };
    const version = det.state === 'detected' ? det.version : null;
    const content = CONTENT[a.id] ? 'verified' as const : 'unavailable' as const;
    const contentRow = CONTENT[a.id] ? { mode: 'native-transcript' as const, assurance: 'verified' as const, evidence: CONTENT[a.id]!, gaps: [] }
      : { mode: 'unavailable' as const, assurance: 'unavailable' as const, evidence: null, gaps: [] };
    const gaps = gapsOf(a.id);
    const base = { agent: a.id, detection, qualified: version === null || qualified(d.catalog, a.id, version), gaps, content };
    const profiles = (d.profiles ?? []).filter((p) => p.agent === a.id).sort((x, y) => (x.id < y.id ? -1 : 1));
    if (!profiles.length) {
      out.push({ key: { agent: a.id, profileId: null }, name: a.displayName, profileLabel: null, version, lifecycleGaps: gaps, receipt: null, content: contentRow,
        ...deriveState({ ...base, profile: false, entries: [], blocked: false, trust: null, receipt: false }) });
      continue;
    }
    for (const p of profiles) {
      const since = d.installedAt(p);
      // code review M4: a busy reconcile never masks a profile with nothing installed; an unreadable manifest is unknown for all
      const entries: ReconcileState[] | 'unavailable' = report?.status === 'ready' ? report.entries.filter((e) => e.profileId === p.id && LIFECYCLE_ROUTES.has(e.route)).map((e) => e.state)
        : since === null && report?.status === 'blocked' && report.code !== 'manifest' ? [] : 'unavailable';
      // code review H, M2: hook policy is Claude's alone; an unreadable policy is unreadable evidence, not a block
      const policy = a.id === 'claude' ? d.policy(p) : null;
      const checked = policy === 'unknown' && entries !== 'unavailable' && entries.length ? [...entries, 'unreadable' as const] : entries;
      const receipt = lastReceipt(d.db, a.id, p.id, since, lifecycleEvents(a.id, d.catalog));
      out.push({ key: { agent: a.id, profileId: p.id }, name: a.displayName, profileLabel: profileLabel(p.origin, p.root, d.home), version, lifecycleGaps: gaps, receipt, content: contentRow,
        ...deriveState({ ...base, profile: true, entries: checked, blocked: policy === 'blocked', trust: a.id === 'codex' ? d.trust(p) : null, receipt: receipt !== null }) });
    }
    if (out.length > MAX_CANDIDATES) break;
  }
  return out;
}

/** One page by stable key (agent, then profile), in either direction. ponytail: rows are rebuilt per request (a handful of
 *  agents and profiles); cache them if a machine ever has thousands of profiles. */
export function answerIntegrationPage(d: PageDeps, req: { cursor: IntegrationKey | null; direction: 'next' | 'previous'; limit: number }): IntegrationPageResult {
  if (d.profiles === null) return { status: 'refused', code: 'starting' };
  if (d.catalog === null) return { status: 'refused', code: 'unavailable' }; // code review: never an empty list
  try {
    const all = rows(d);
    if (all.length > MAX_CANDIDATES) return { status: 'refused', code: 'too-large' };
    const limit = Math.min(req.limit, INTEGRATION_PAGE_MAX);
    let start = 0, end = all.length;
    if (req.cursor) {
      const at = all.findIndex((r) => order(r.key) === order(req.cursor!));
      if (at < 0) return { status: 'refused', code: 'stale-cursor' };
      if (req.direction === 'next') { start = at + 1; end = Math.min(all.length, start + limit); } else { end = at; start = Math.max(0, end - limit); }
    } else if (req.direction === 'next') end = Math.min(all.length, limit);
    else start = Math.max(0, end - limit);
    const page = all.slice(start, end);
    return { status: 'ready', observedAt: d.now, value: { rows: page, previous: start > 0 && page.length ? page[0]!.key : null, next: end < all.length && page.length ? page.at(-1)!.key : null } };
  } catch {
    return { status: 'refused', code: 'failed' };
  }
}

/** The production evidence for a page: the manifest is read once per request; each profile check that fails is unknown. */
export function pageEvidence(o: { db: DatabaseSync; dataDir: string }): Pick<PageDeps, 'installedAt' | 'trust' | 'policy'> {
  let manifest: ManifestEntry[] = [];
  try { manifest = readManifest(o.dataDir).filter((e) => e.state === 'applied'); } catch { /* none: nothing installed shows as such */ }
  const lifecycle = (p: Profile) => manifest.filter((e) => LIFECYCLE_ROUTES.has(e.route) && within(e.target, p.root));
  return {
    installedAt: (p) => { const t = lifecycle(p).map((e) => Math.max(Date.parse(e.at), e.seen?.since ?? 0)).filter(Number.isFinite); return t.length ? Math.max(...t) : null; },
    trust: (p) => {
      if (!lifecycle(p).length) return null;
      try { const s = codexHookStatus({ dataDir: o.dataDir, profileKey: p.id, codexHome: p.root, bounds: { root: p.root, denied: [] }, db: o.db }).state; return s === 'not-installed' ? null : s; } catch { return 'awaiting-trust'; }
    },
    policy: (p) => {
      if (p.agent !== 'claude' || !lifecycle(p).length) return null;
      try { const s = claudeHookPolicy({ configDir: p.root }).state; return s === 'ok' ? null : s; } catch { return 'unknown'; }
    },
  };
}
