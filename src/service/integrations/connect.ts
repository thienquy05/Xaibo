// XAIBO-PROD-557 (P6-T03 part 1a; FR-30..FR-34, FR-45, EC-48, EC-73; design: Codex, .handoff/p6-t03-design.md; owner D-P6-06):
// Connect, Disconnect and Uninstall over the FR-32 engine routes, for disposable profiles; real profiles only while
// REAL_PROFILE_ENABLED (XAIBO-PROD-599, P6-T12 slice 1, D-P6-21: realBounds).
// previewConnect builds a profile's steps (Claude: settings-fallback hooks, then the retention raise, then the default-off
// tee; Codex: hooks plus guided trust steps, trust never written; agy: hooks; Gemini: not offered until S11) and holds them
// in memory by preview id. applyConnect applies step 1's stored Plan unchanged and rebuilds each later step, applying it
// only if it equals the previewed one (route, target, owned values with what they replace, created keys); otherwise, or when
// a step fails, this Connect is undone newest first and a new preview is shown. Disconnect and Uninstall revert newest
// first, each entry bounds-checked on its own, and stop on a target after a conflict, refusal or error.
// XAIBO-PROD-560 (part 2b; owner D-P6-07): Claude's route comes from the catalog and the detected version (plugin preferred,
// unverified otherwise); the plugin step is previewed (previewPlugin: settings, executable and interpreter identity) and
// installed through `claude plugin` under the operation lock, held across the awaits; retention and tee after it are rebuilt
// and applied only when equal to the preview (D-P6-06). Part 2c (XAIBO-PROD-561): Disconnect, Uninstall and this undo remove a
// plugin entry last on its file (after tee and retention) through the hardened uninstallPlugin.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isProfileKey } from '../../shared/hook-protocol.ts';
import { APPLY_ITEMS, REMOVAL_LIMIT, type ApplyKind, type ApplyLabel, type ApplyOffer, type RemovalItem } from '../../shared/ipc.ts';
import { agyHooksFile, checkAgyInstall } from '../adapters/agy/setup.ts';
import { deployShim, installPlugin, PLUGIN_REF, pluginHooks, previewPlugin, teePlan, uninstallPlugin, type PluginOptions, type PluginPreview } from '../adapters/claude/setup.ts';
import { codexHookOps, codexTrustSteps, shimPath } from '../adapters/codex/setup.ts';
import type { Detection, Profile } from '../catalog/detect.ts';
import type { Catalog } from '../catalog/validate.ts';
import { claudeConnectRoute, claudeRetentionOffer, reportOps, retentionOps, type RetentionOffer, type SetupAccess } from '../catalog/setup-plans.ts';
import { privateDir, real, REAL_PROFILE_ENABLED, writable } from '../config/bounds.ts';
import { acquireLock, judge, lockState, type Writer } from '../config/lock.ts';
import {
  apply, BACKUP_NAME, ConfigError, dropEntry, plan, privateDirs, readFile, readManifest, revert, within, type Bounds, type DiffLine, type ManifestEntry, type Op, type Plan, type Route,
} from '../config/transaction.ts';
import { reconcile as scan, runsShim, XAIBO_SHIM, type Leftover, type ReconcileReport, type Target } from './reconcile.ts';

export interface ConnectContext {
  dataDir: string;
  /** Real agent roots (bounds.ts deniedRootsFrom); null or empty (login environment unreadable) refuses every call. */
  denied: string[] | null;
  /** Disposable roots a profile must be strictly below (bounds.ts writable). */
  allowed: string[];
  claudeManagedDir: string;
  /** The bundled helpers deployShim copies (xaibo-report sits beside `hook`). */
  helpers: { hook: string; forwarder: string; statusline: string };
  /** Part 2b: the bundled catalog (connectRoutes; null when it failed to load: Claude unverified), the live detection per agent
   *  and the login PATH the plugin CLI runs with (null: refused). */
  catalog: Catalog | null;
  detection: (agent: string) => Detection | undefined;
  cliPath: string | null;
  /** XAIBO-PROD-589 (P6-T09a slice B, D-P6-18): a report-v1 agent's declared setup and its access, read fresh on every call
   *  (boot: setupAccess over the private import store); null when the agent declares none. Absent: no report agents. */
  setupAccess?: (agent: string) => SetupAccess | null;
  /** Monotonic ms (default performance.now). */
  now?: () => number;
  /** Test only (part 2a review L4): passed to the engine's apply() to inject a failure after a step's rename. The service's
   *  connectContext() never sets it. */
  afterRename?: (file: string) => void;
  /** XAIBO-PROD-599 (code review M1): each agent's own real roots (bounds.ts agentRootsFrom); absent or null: no real profile. */
  realRoots?: Record<string, string[]> | null;
  /** Test only (XAIBO-PROD-599, review L8): overrides REAL_PROFILE_ENABLED. The service's connectContext() never sets it. */
  realProfiles?: boolean;
}
/** teeOnly (XAIBO-PROD-580, R6): the claude-tee step alone (the separate tee); never set from a renderer selection. */
export interface Selections { retention: boolean; tee: boolean; teeOnly?: boolean }
/** cli (the plugin step only): the detected version, the argv with the plugin folder as `<plugin-dir>` (review H2) and what
 *  the CLI writes, relative to the config dir. */
export interface StepView { route: Route; target: string; diff: DiffLine[]; cli?: { version: string; argv: string[][]; writes: string[] } }
export type Refused = { status: 'refused'; code: string };
/** Part 2: removed = records dropped; left = of those, the ids whose backup could not be removed (an inert leftover). */
export type CleanupPreview = { status: 'preview'; previewId: string; ttlMs: number; items: { entry: string; cleanup: Leftover[] }[] };
export type CleanupResult = { status: 'cleaned'; removed: string[]; left: string[] } | { status: 'needs-preview' }
  | { status: 'partial'; removed: string[]; left: string[]; code: string } | Refused;
/** XAIBO-PROD-576 (P6-T10 unit 3): a removal preview; profileId null = Full Uninstall (every recorded entry). */
export type RemovalPreview = { status: 'preview'; previewId: string; profileId: string | null; ttlMs: number; items: RemovalItem[] };
export type RemovalResult = Outcome | { status: 'needs-preview'; preview: RemovalPreview | Refused } | Refused;
export type Preview = { status: 'preview'; previewId: string; profileId: string; ttlMs: number; steps: StepView[]; retention: RetentionOffer | null; trustSteps: string[] };
export type ConnectResult = { status: 'applied'; entries: string[]; trustSteps: string[] } | { status: 'needs-preview'; preview: Preview | Refused }
  | Refused | (Outcome & { status: 'partial'; code: string });
export interface Outcome {
  status: 'disconnected' | 'partial';
  reverted: { entry: string; route: Route; result: string }[];
  conflicts: { entry: string; route: Route; pointer: string }[];
  /** reason: refused (outside the writable roots), blocked (a newer entry on that file stopped), plugin (part 2), or an error code */
  remaining: { entry: string; route: Route; reason: string }[];
}

const TTL_MS = 5 * 60_000;
const MAX_PREVIEWS = 32;
const fail = (code: ConfigError['code']): never => { throw new ConfigError(code); };
const refused = (code: string): Refused => ({ status: 'refused', code });
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const uid = process.getuid?.();

/** Design review H1: each agent's exact file and routes, used by preview and by Disconnect (never "anything under the root"). */
export function targetOf(p: Profile): Target | null {
  let root: string;
  try { root = realpathSync.native(p.root); } catch { return null; }
  if (p.agent === 'claude') return { dir: root, file: path.join(root, 'settings.json'), routes: ['claude-plugin', 'claude-settings-fallback', 'claude-retention', 'claude-tee'] };
  if (p.agent === 'codex') return { dir: root, file: path.join(root, 'hooks.json'), routes: ['codex-hooks'] };
  // agy's catalog root is <home>/.gemini/antigravity-cli, its hooks file <home>/.gemini/config/hooks.json (default origin only)
  if (p.agent === 'agy' && p.origin === 'default' && path.basename(root) === 'antigravity-cli' && path.basename(path.dirname(root)) === '.gemini') {
    const home = path.dirname(path.dirname(root));
    return { dir: home, file: agyHooksFile(home), routes: ['agy-hooks'] };
  }
  return null; // Gemini (and anything else): not offered until verified (PRD EC-90, D-19, §6)
}

/** The settings-fallback hook groups: the plugin's hooks appended under /hooks/<event>, foreign hooks kept (D-2). */
const fallbackOps = (shim: string, key: string): Op[] =>
  Object.entries(pluginHooks(shim, key).hooks).flatMap(([ev, groups]) => groups.map((value) => ({ op: 'append' as const, pointer: `/hooks/${ev}`, value })));
/** Design review H2: hooks already running a Xaibo shim (even with the manifest lost) are never appended again. */
function noShim(file: string, agent: string) {
  const cur = readFile(file);
  if (!cur) return;
  let doc: unknown;
  try { doc = JSON.parse(cur.bytes.toString('utf8')); } catch { return fail('invalid-json'); }
  if (runsShim(doc, XAIBO_SHIM(agent))) fail('duplicate');
}

type Builder = [Route, () => Plan];
interface Plugin { o: PluginOptions; version: string }
/** owner: the requesting port (part 1b review L5); only that owner applies the preview. plugin: the confirmed plugin step. */
interface Held {
  profile: Profile; sel: Selections; owner: unknown; plugin: { o: PluginOptions; pp: PluginPreview } | null;
  /** XAIBO-PROD-589: the report access the preview was built from, rechecked at apply before any helper is deployed. */
  report: SetupAccess | null;
  steps: { route: Route; build: () => Plan; plan: Plan }[]; trust: string[]; expiresAt: number;
  /** XAIBO-PROD-600: a real-profile preview (realBounds), applied only through main's confirmation; the offer it showed. */
  real: boolean; retention: RetentionOffer | null;
}
const WRITES = ['settings.json', '.claude.json', 'plugins/known_marketplaces.json', 'plugins/installed_plugins.json', 'plugins/cache/'];
const pluginView = (pp: PluginPreview, version: string): StepView => ({
  route: 'claude-plugin', target: pp.target, diff: [{ pointer: `/enabledPlugins/${PLUGIN_REF}`, new: true }],
  cli: { version, argv: [['plugin', 'marketplace', 'add', '<plugin-dir>'], pp.argv[1]!], writes: WRITES },
});
const regularFile = (f: string) => { try { return lstatSync(f).isFile(); } catch { return false; } };

export function createConnect(ctx: ConnectContext) {
  const now = ctx.now ?? (() => performance.now());
  // code review M-c: no denylist means the real roots are unknown: refuse every call, never fail open
  const denied = ctx.denied?.length ? ctx.denied : null;
  /** The profile's own dir and the folder of the file written are both private and disposable (code review M-d: agy). */
  const permitted = (t: Target) => !!denied && writable(t.dir, ctx.allowed, denied) && writable(path.dirname(t.file), ctx.allowed, denied);
  // XAIBO-PROD-599 (P6-T12 slice 1, D-P6-21; design review H1-H3, M6): with REAL_PROFILE_ENABLED, a real profile's native
  // target: a default- or env-origin profile (never a renderer-chosen manual folder) whose own root is a known real root
  // (on the denylist), never one holding a home. Bounds: the file's own folder, with every other real root and Xaibo's data
  // dir still denied (a denied root holding the file refuses: overlapping roots), and every folder from the file's up to its
  // own root private to this user (a link refuses). ponytail: folders above the own root are not checked (the home, or an env
  // root's parents); check them if an env root ever sits in a shared folder.
  const realOn = ctx.realProfiles ?? REAL_PROFILE_ENABLED;
  const homes = [os.homedir(), os.userInfo().homedir].map(real);
  function realBounds(p: Profile, t: Target): Bounds | null {
    if (!realOn || !denied || (p.origin !== 'default' && p.origin !== 'env')) return null;
    const native = targetOf(p);
    if (!native || native.file !== t.file) return null;
    const own = p.agent === 'agy' ? path.dirname(real(p.root)) : native.dir; // agy: <home>/.gemini
    // code review M1: this agent's own root (never another agent's, e.g. CLAUDE_CONFIG_DIR=~/.codex), still on the denylist
    if (!ctx.realRoots?.[p.agent]?.includes(own) || !denied.includes(own) || homes.some((h) => within(h, own))) return null;
    const rest = [...denied.filter((x) => x !== own), real(ctx.dataDir)];
    if (rest.some((x) => within(t.file, x))) return null;
    for (let cur = path.dirname(t.file); ; cur = path.dirname(cur)) {
      if (!within(cur, own) || !privateDir(cur)) return null;
      if (cur === own) break;
    }
    return { root: path.dirname(t.file), denied: rest };
  }
  /** The disposable bounds as before, else a real profile's, else null (refused before any read). */
  const boundsFor = (p: Profile, t: Target): Bounds | null => (permitted(t) ? { root: t.dir, denied: denied! } : realBounds(p, t));
  const refusal = () => refused(realOn ? 'unsafe-profile' : 'real-profile');
  /** XAIBO-PROD-600 (review H1): the profile's target is a real one now (not disposable, real bounds). */
  const nowReal = (p: Profile) => { const t = targetFor(p); return !!t && !permitted(t) && !!realBounds(p, t); };
  /** XAIBO-PROD-600: a recorded entry on a real profile (outside the disposable roots, real bounds for a live profile). */
  const realEntry = (e: ManifestEntry, d: string[], profiles: readonly Profile[]) => !writable(path.dirname(e.target), ctx.allowed, d) && !!entryBounds(e, d, profiles);
  /** H3: a recorded entry's bounds: disposable by its folder, else only as a currently resolved real target of one of
   *  `profiles` (never the manifest alone; never the plugin route on a real root, decision A). */
  const entryBounds = (e: ManifestEntry, d: string[], profiles: readonly Profile[]): Bounds | null => {
    const dir = path.dirname(e.target);
    if (writable(dir, ctx.allowed, d)) return { root: real(dir), denied: d };
    if (e.route === 'claude-plugin') return null;
    for (const p of profiles) {
      const t = targetOf(p);
      const b = t && t.file === e.target && t.routes.includes(e.route) ? realBounds(p, t) : null;
      if (b) return b;
    }
    return null;
  };
  /** XAIBO-PROD-589: a native agent's file, else a report agent's declared file under its profile root, only while that root is
   *  the approved one (Disconnect and removal need no grant: reversal is authorized by the manifest, design §3), and never
   *  through a linked folder (code review M2: the manifest records the resolved path, so Disconnect would miss the entry).
   *  ponytail (code review L2): once the root approval lapses, per-profile Disconnect answers unverified and only Full
   *  Uninstall reverts the entry; resolve report targets from the manifest if that ever strands an owner. */
  const targetFor = (p: Profile, access = onceEach()): Target | null => {
    const native = targetOf(p);
    if (native) return native;
    const a = access(p.agent);
    if (!a?.root) return null;
    let root: string;
    try { root = realpathSync.native(p.root); } catch { return null; }
    if (root !== a.root) return null;
    const file = path.join(root, a.setup.file);
    try { if (realpathSync.native(path.dirname(file)) !== path.dirname(file)) return null; } catch { /* no parent folder: plan() refuses it */ }
    return { dir: root, file, routes: ['report-setup'] };
  };
  /** XAIBO-PROD-608 (Gate 6 second review 4): each setupAccess call reads the private import store, so a scan, a preview and
   *  an apply each read it at most once per agent. */
  function onceEach(): (agent: string) => SetupAccess | null {
    const m = new Map<string, SetupAccess | null>();
    return (a) => { if (!m.has(a)) m.set(a, ctx.setupAccess?.(a) ?? null); return m.get(a)!; };
  }
  /** Xaibo's own data dir is never a report-setup target (review: deniedRootsFrom lists agent roots only). */
  const reportDenied = (d: string[]) => [...d, real(ctx.dataDir)];
  const previews = new Map<string, Held>();
  const recorded = (file: string, routes: Route[]) => readManifest(ctx.dataDir).some((e) => e.target === file && routes.includes(e.route));

  /** Selections, profile key and helper paths are captured here, never taken from an apply request (review L1). */
  function builders(p: Profile, t: Target, sel: Selections, report: SetupAccess | null, bounds: Bounds): { plugin: Plugin | null; list: Builder[]; retention: RetentionOffer | null; trust: string[] } {
    const key = isProfileKey(p.id) ? p.id : fail('ops');
    const isReal = !permitted(t); // boundsFor gave the real profile's bounds
    const shim = shimPath(ctx.dataDir);
    if (t.routes[0] === 'report-setup') {
      const a = report ?? fail('unverified'); // code review L1: the access read once by the preview, never a second store read
      const helper = path.join(path.dirname(shim), 'xaibo-report'); // where deployShim puts it
      return { list: [['report-setup', () => {
        // review M2: a file any manifest entry manages, on any route, is refused (agy's hooks file, another agent's config)
        if (readManifest(ctx.dataDir).some((e) => e.target === t.file)) fail('duplicate');
        return plan(t.file, 'report-setup', reportOps(a.setup, { helper, profileKey: key, agent: p.agent }), { root: t.dir, denied: reportDenied(denied!) });
      }]], plugin: null, retention: null, trust: [] }; // Claude's offers (retention, tee) never apply
    }
    // code review M1: and no native route writes a file a report-setup entry manages (the report builder refuses the reverse)
    if (readManifest(ctx.dataDir).some((e) => e.route === 'report-setup' && e.target === t.file)) fail('duplicate');
    if (p.agent === 'codex') {
      return { list: [['codex-hooks', () => {
        if (recorded(t.file, ['codex-hooks'])) fail('duplicate');
        noShim(t.file, 'codex');
        return plan(t.file, 'codex-hooks', codexHookOps(shim, key), bounds);
      }]], plugin: null, retention: null, trust: codexTrustSteps(t.dir, shim, key) };
    }
    if (p.agent === 'agy') {
      return { list: [['agy-hooks', () => { const c = checkAgyInstall({ dataDir: ctx.dataDir, profileKey: key, profileHome: t.dir, bounds }); return plan(c.file, 'agy-hooks', c.ops, bounds); }]],
        plugin: null, retention: null, trust: [] }; // ponytail: no project selected, so a project's .agents/hooks.json is not inspected
    }
    const d = ctx.detection('claude');
    // D-2, D-P6-07: no chooser, never a fallback after a failure; D-P6-21 A: never the plugin route on a real profile
    const route = ctx.catalog ? claudeConnectRoute(ctx.catalog, d, !isReal) : null;
    if (!route || d?.state !== 'detected') return fail('unverified');
    // XAIBO-PROD-580 (R6): the separate tee: its step alone, no hooks or retention
    if (sel.teeOnly) return { plugin: null, list: [['claude-tee', () => teePlan({ dataDir: ctx.dataDir, profileKey: key, configDir: t.dir, bounds })]], retention: null, trust: [] };
    const list: Builder[] = [];
    let plugin: Plugin | null = null;
    if (route === 'claude-plugin') {
      noShim(t.file, 'claude'); // settings hooks already running a Xaibo shim would deliver every event twice (EC-09)
      plugin = { o: { dataDir: ctx.dataDir, profileKey: key, configDir: t.dir, claude: d.path, bounds, path: ctx.cliPath!, expect: d.id }, version: d.version! };
    } else {
      list.push(['claude-settings-fallback', () => {
        if (recorded(t.file, ['claude-plugin', 'claude-settings-fallback'])) fail('duplicate');
        noShim(t.file, 'claude');
        return plan(t.file, 'claude-settings-fallback', fallbackOps(shim, key), bounds);
      }]);
    }
    // ponytail: a partial (conflicted) retention entry keeps the offer at `connected` until Disconnect resolves it (P6-T02)
    const retention = claudeRetentionOffer(t.dir, ctx.claudeManagedDir, readManifest(ctx.dataDir));
    if (sel.retention && retention.offered) {
      list.push(['claude-retention', () => {
        const ops = retentionOps(claudeRetentionOffer(t.dir, ctx.claudeManagedDir, readManifest(ctx.dataDir)));
        return ops.length ? plan(t.file, 'claude-retention', ops, bounds) : fail('retention'); // no longer offered: a mismatch
      }]);
    }
    if (sel.tee) list.push(['claude-tee', () => teePlan({ dataDir: ctx.dataDir, profileKey: key, configDir: t.dir, bounds })]);
    return { plugin, list, retention, trust: [] };
  }

  /** Part 2a review L3: while another writer holds the lock a preview made now would fail at apply: busy, or stale-lock when
   *  its holder is gone (code review L-c: never "try again" forever). */
  function previewConnect(p: Profile, sel: Selections, owner?: unknown): Preview | Refused {
    const state = denied ? lockState(ctx.dataDir) : 'free';
    return state === 'free' ? preview(p, sel, owner) : refused(state);
  }
  function preview(p: Profile, sel: Selections, owner?: unknown): Preview | Refused {
    if (!denied) return refused('bounds-unavailable');
    if (sel.teeOnly && p.agent !== 'claude') return refused('unsupported'); // XAIBO-PROD-580: only Claude has the statusLine tee
    // XAIBO-PROD-589 (design §3): a report agent's root approval and setup grant, before any target is read
    const access = onceEach();
    const report = targetOf(p) ? null : access(p.agent);
    if (report) {
      let root: string | null = null;
      try { root = realpathSync.native(p.root); } catch { /* no profile folder: not the approved root */ }
      if (!report.root || root !== report.root) return refused('root-not-approved');
      if (!report.granted) return refused('setup-not-granted');
    }
    const t = targetFor(p, access);
    if (!t) return refused('unverified');
    const bounds = boundsFor(p, t);
    if (!bounds) return refusal(); // before any offer read (review H3, M4)
    if (p.agent === 'claude' && !ctx.cliPath) return refused('bounds-unavailable'); // no login PATH: like no denylist
    // part 1b review M2: the helpers apply will deploy exist, before the owner confirms (xaibo-report ships beside the hook)
    const helpers = [ctx.helpers.hook, path.join(path.dirname(ctx.helpers.hook), 'xaibo-report'), ctx.helpers.forwarder, ...(sel.tee && p.agent === 'claude' ? [ctx.helpers.statusline] : [])];
    if (!helpers.every(regularFile)) return refused('helpers-unavailable');
    let b, steps, pp: PluginPreview | null = null;
    try {
      b = builders(p, t, sel, report, bounds);
      if (b.plugin) pp = previewPlugin(b.plugin.o); // nothing runs, nothing is written
      steps = b.list.map(([route, build]) => ({ route, build, plan: build() }));
    } catch (e) { if (e instanceof ConfigError) return refused(e.code); throw e; }
    const at = now();
    for (const [id, h] of previews) if (h.expiresAt < at) previews.delete(id);
    // one per profile, the separate tee its own scope (unit 6a review L2: opening it never evicts a held Connect preview)
    const own = [...previews].filter(([, h]) => h.profile.id === p.id && !!h.sel.teeOnly === !!sel.teeOnly).map(([id]) => id);
    if (previews.size - own.length >= MAX_PREVIEWS) return refused('busy'); // checked before the profile's own is dropped
    for (const id of own) previews.delete(id); // one per profile
    const previewId = randomUUID();
    previews.set(previewId, { profile: p, sel, owner, report, plugin: b.plugin && pp ? { o: b.plugin.o, pp } : null, steps, trust: b.trust, expiresAt: at + TTL_MS, real: !permitted(t), retention: b.retention });
    const views: StepView[] = steps.map((s) => ({ route: s.route, target: s.plan.target, diff: s.plan.diff }));
    return {
      status: 'preview', previewId, profileId: p.id, ttlMs: TTL_MS, steps: b.plugin && pp ? [pluginView(pp, b.plugin.version), ...views] : views,
      retention: b.retention, trustSteps: b.trust,
    };
  }

  /** Design review M3: stricter than the redacted diff: route, target, owned values with the full value they replace, created. */
  const same = (a: Plan, b: Plan) => a.route === b.route && a.target === b.target && isDeepStrictEqual(a.owned, b.owned) && isDeepStrictEqual(a.created, b.created);

  /** XAIBO-PROD-612: the lock's writer class: 'external' when the operation may run `claude plugin`, or when that can't be told.
   *  Only from entries fixed before the lock (a removal's preview, rechecked under it); Disconnect and Uninstall read their
   *  manifest only under the lock, so they are always external (review LOW 1). */
  const writerOf = (entries: () => readonly ManifestEntry[]): Writer => { try { return entries().some((e) => e.route === 'claude-plugin') ? 'external' : 'service'; } catch { return 'external'; } };
  /** Part 2a: under the operation lock, taken before the preview is looked up, so `busy` keeps the preview for a retry. */
  async function applyConnect(previewId: string, owner?: unknown): Promise<ConnectResult> {
    if (!denied) return refused('bounds-unavailable');
    // XAIBO-PROD-600 (review H1, M4): a real-class preview (as previewed or now) only through main's confirmation; refused
    // before the lock is taken or the lookup consumes it, so main's confirm can still use it
    const held = previews.get(previewId);
    if (held && held.owner === owner && (held.real || nowReal(held.profile))) return refused('needs-confirmation');
    return locked(held?.plugin ? 'external' : 'service', () => applyLocked(previewId, owner, false));
  }
  /** The operation lock around one whole operation, held until its promise settles (part 2b: the CLI awaits); a held or stale
   *  lock is the refusal, nothing else is touched. */
  async function locked<T>(writer: Writer, fn: () => T | Promise<T>): Promise<T | Refused> {
    let lock;
    try { lock = acquireLock(ctx.dataDir, writer); } catch (e) { return refused(e instanceof ConfigError ? e.code : 'failed'); } // nothing written yet (code review L-b)
    try { return await fn(); } finally { lock.release(); }
  }
  async function applyLocked(previewId: string, owner: unknown, confirmed: boolean): Promise<ConnectResult> {
    const h = previews.get(previewId);
    previews.delete(previewId); // consumed on first lookup, whatever happens next, a wrong owner included (review L1, 1b L5)
    if (!h || h.owner !== owner) return refused('preview-invalid');
    if (now() > h.expiresAt) return refused('preview-expired');
    if (!denied) return refused('bounds-unavailable');
    const access = onceEach();
    const again = (): ConnectResult => ({ status: 'needs-preview', preview: preview(h.profile, h.sel, h.owner) }); // 1b review M1; we hold the lock
    if (h.report) { // XAIBO-PROD-589: the grant, root and declared setup still as previewed, before any helper is deployed
      const a = access(h.profile.agent);
      if (!a?.granted || a.root !== h.report.root || !isDeepStrictEqual(a.setup, h.report.setup)) return again();
    }
    const t = targetFor(h.profile, access);
    const bounds = t && boundsFor(h.profile, t);
    if (!t || !bounds) return refusal();
    if (!confirmed && !permitted(t)) return refused('needs-confirmation'); // review H1: decided again under the lock
    // checked before any helper is deployed: bytes, file identity and mode, as apply() / installPlugin will (review L2)
    const first = h.plugin ? h.plugin.pp.settings : h.steps[0]!.plan.preHash === null ? null : { hash: h.steps[0]!.plan.preHash, dev: h.steps[0]!.plan.dev, ino: h.steps[0]!.plan.ino, mode: h.steps[0]!.plan.mode };
    const cur = readFile(h.plugin ? h.plugin.pp.target : h.steps[0]!.plan.target);
    if (!isDeepStrictEqual(cur ? { hash: sha256(cur.bytes), dev: cur.dev, ino: cur.ino, mode: cur.mode } : null, first)) return again();
    deployShim(ctx.dataDir, { hook: ctx.helpers.hook, forwarder: ctx.helpers.forwarder, ...(h.steps.some((s) => s.route === 'claude-tee') ? { statusline: ctx.helpers.statusline } : {}) });
    const done: ManifestEntry[] = [];
    const undo = async (code: string | null, extra: ManifestEntry[] = []): Promise<ConnectResult> => {
      const u = await revertAll([...done, ...extra], denied, [h.profile]);
      if (u.status === 'partial') return { ...u, status: 'partial', code: code ?? 'mismatch' };
      return code === null ? again() : refused(code);
    };
    if (h.plugin) {
      let known: Set<string>;
      try { known = new Set(readManifest(ctx.dataDir).map((e) => e.id)); } catch { return await undo('failed'); }
      try { done.push(await installPlugin(h.plugin.o, h.plugin.pp)); } catch (e) {
        let residue: ManifestEntry[];
        try { residue = readManifest(ctx.dataDir).filter((x) => !known.has(x.id)); } catch { return await undo('failed'); } // code review L3
        // a kept pending entry is undone first (M1)
        const code = e instanceof ConfigError ? e.code : 'failed';
        return await undo(code === 'changed' && !residue.length ? null : code, residue); // changed before any write: a fresh preview
      }
      // design §4: offers are rechecked even when none was previewed; a retention raise appearing now is a step-count change
      if (h.sel.retention && !h.steps.some((s) => s.route === 'claude-retention')
        && claudeRetentionOffer(t.dir, ctx.claudeManagedDir, readManifest(ctx.dataDir)).offered) return await undo(null);
    }
    for (const [i, step] of h.steps.entries()) {
      const rebuilt = !!h.plugin || i > 0; // after the CLI rewrite every later step is rebuilt and compared (D-P6-06)
      let next: Plan;
      try { next = rebuilt ? step.build() : step.plan; } catch (e) { return await undo(e instanceof ConfigError ? null : 'failed'); } // code review M-a
      if (rebuilt && !same(next, step.plan)) return await undo(null);
      let known: Set<string>;
      try { known = new Set(readManifest(ctx.dataDir).map((e) => e.id)); } catch { return await undo('failed'); } // review L-5: undone, never left half applied
      try { done.push(apply(next, { dataDir: ctx.dataDir, bounds: next.route === 'report-setup' ? { root: t.dir, denied: reportDenied(denied) } : bounds, ...(ctx.afterRename ? { afterRename: ctx.afterRename } : {}) })); } catch (e) {
        // review M1: a step that threw after recording its entry leaves a pending entry: it is undone first
        const residue = readManifest(ctx.dataDir).filter((x) => !known.has(x.id));
        return await undo(e instanceof ConfigError ? e.code : 'failed', residue);
      }
    }
    return { status: 'applied', entries: done.map((e) => e.id), trustSteps: h.trust };
  }

  /** Newest first (manifest order is creation order, review M2); per entry: writable roots (review H3), then stop rules (L3). */
  async function revertAll(list: ManifestEntry[], d: string[], profiles: readonly Profile[]): Promise<Outcome> {
    const out: Outcome = { status: 'disconnected', reverted: [], conflicts: [], remaining: [] };
    const stopped = new Set<string>();
    for (const e of [...list].reverse()) {
      const at = { entry: e.id, route: e.route }, dir = path.dirname(e.target);
      const stop = (reason: string) => { out.remaining.push({ ...at, reason }); stopped.add(e.target); };
      const b = entryBounds(e, d, profiles);
      if (!b) { stop('refused'); continue; }
      if (stopped.has(e.target)) { out.remaining.push({ ...at, reason: 'blocked' }); continue; }
      if (e.route === 'claude-plugin') { await removePlugin(e, dir, d, out, stop, () => stopped.add(e.target)); continue; }
      try {
        const r = revert(e, { dataDir: ctx.dataDir, bounds: b });
        out.reverted.push({ ...at, result: r.result });
        if (r.conflicts.length) { out.conflicts.push(...r.conflicts.map((c) => ({ ...at, pointer: c.pointer }))); stopped.add(e.target); }
      } catch (err) { stop(err instanceof ConfigError ? err.code : 'failed'); }
    }
    if (out.conflicts.length || out.remaining.length) out.status = 'partial';
    return out;
  }

  /** XAIBO-PROD-561 (part 2c): a plugin entry is removed through `claude plugin` (uninstallPlugin proves ownership first), only
   *  with an auto-detected Claude whose version qualifies the plugin route (review H1: never a renderer-chosen executable, never
   *  the one recorded at install); a legacy entry (no profile key or journal) is never inferred. */
  async function removePlugin(e: ManifestEntry, dir: string, d: string[], out: Outcome, stop: (reason: string) => void, block: () => void) {
    const at = { entry: e.id, route: e.route };
    const det = ctx.detection('claude');
    if (!e.profileKey || !e.phase) return stop('legacy');
    if (!ctx.cliPath) return stop('bounds-unavailable');
    if (!ctx.catalog || claudeConnectRoute(ctx.catalog, det) !== 'claude-plugin' || det?.state !== 'detected') return stop('unverified');
    try {
      const r = await uninstallPlugin({ dataDir: ctx.dataDir, profileKey: e.profileKey, configDir: dir, claude: det.path, bounds: { root: real(dir), denied: d }, path: ctx.cliPath, expect: det.id });
      out.conflicts.push(...r.conflicts.map((c) => ({ ...at, pointer: c.pointer })));
      if (r.result === 'unchanged') return stop(r.residue.length && !r.conflicts.length ? 'residue' : 'conflict');
      if (readManifest(ctx.dataDir).some((x) => x.id === e.id)) return stop('partial'); // code review M2: kept, so not reverted
      out.reverted.push({ ...at, result: r.result });
      if (r.conflicts.length) block(); // older entries on that file wait (L3); this one is reverted
    } catch (err) { stop(err instanceof ConfigError ? err.code : 'failed'); }
  }

  /** Test and dev only (code review 7): no IPC route reaches it; a renderer-facing caller must go through previewRemoval and
   *  main's confirmation for a real profile (XAIBO-PROD-600). */
  async function disconnect(p: Profile): Promise<Outcome | Refused> {
    if (!denied) return refused('bounds-unavailable');
    const t = targetFor(p);
    if (!t) return refused('unverified');
    return locked('external', () => revertAll(readManifest(ctx.dataDir).filter((e) => e.target === t.file && t.routes.includes(e.route)), denied, [p]));
  }

  /** Every recorded entry, including profiles no longer detected; history and the shim stay (FR-34; orphan shim: P6-T05).
   *  XAIBO-PROD-599 H3: an entry on a real root only for one of `profiles` (the live ones). */
  const uninstall = async (profiles: readonly Profile[]): Promise<Outcome | Refused> => (denied ? locked('external', () => revertAll(readManifest(ctx.dataDir), denied, profiles)) : refused('bounds-unavailable'));

  /** A closed port's previews can never be applied: drop them (part 1b review L5). */
  const dropOwner = (owner: unknown) => {
    for (const [id, h] of previews) if (h.owner === owner) previews.delete(id);
    for (const [id, c] of cleanups) if (c.owner === owner) cleanups.delete(id); // part 2 review C7
    for (const [id, r] of removals) if (r.owner === owner) removals.delete(id); // XAIBO-PROD-576 plan review L5
    for (const [id, l] of lockClears) if (l.owner === owner) lockClears.delete(id); // XAIBO-PROD-613
  };

  /** XAIBO-PROD-562 (P6-T04 part 1, EC-26): the read-only reconcile over the current profiles; the IPC reads (P6-T10) run their
   *  own fresh reconcile, the latest report is kept for tests and cleanup's refresh. Same denylist and writable roots as every write. */
  let latest: ReconcileReport | null = null;
  const allowedTarget = (t: Target, p: Profile) => !!boundsFor(p, t);
  const reconcile = (profiles: readonly Profile[]) => { const a = onceEach(); return (latest = scan({ dataDir: ctx.dataDir, denied, profiles, target: (p) => targetFor(p, a), permitted: allowedTarget })); };
  const reconciled = () => latest;

  // XAIBO-PROD-563 (P6-T04 part 2; slice and review C1-C8 in .handoff/p6-t04-design.md): one preview and one confirmation
  // clean up entries a fresh reconcile reports disconnected-externally: their manifest record, then their backup. Their owned
  // values are already gone, so no agent profile file is written and no CLI runs; the plugin copy and a still-registered
  // marketplace stay manual (P6-T12). Previews as Connect's (TTL, single use, owner-bound, max 32) in their own map (C7).
  const cleanups = new Map<string, { profiles: readonly Profile[]; entries: ManifestEntry[]; owner: unknown; expiresAt: number; scope?: string; real: boolean }>();
  const current = (profiles: readonly Profile[], held: boolean) => { const a = onceEach(); return scan({ dataDir: ctx.dataDir, denied, profiles, target: (p) => targetFor(p, a), permitted: allowedTarget, held }); };

  /** `scope` (XAIBO-PROD-576 plan review M2): the profile the IPC asked for; one held preview per scope, busy checked first. */
  function previewCleanup(profiles: readonly Profile[], ids: readonly string[], owner?: unknown, scope?: string): CleanupPreview | Refused {
    if (!denied) return refused('bounds-unavailable');
    if (!ids.length || new Set(ids).size !== ids.length) return refused('ops'); // C8
    const r = current(profiles, false);
    if (r.status === 'blocked') return refused(r.code);
    const items = ids.map((id) => r.entries.find((e) => e.entry === id && e.state === 'disconnected-externally'));
    let manifest: ManifestEntry[];
    try { manifest = readManifest(ctx.dataDir); } catch { return refused('manifest'); }
    const entries = ids.map((id) => manifest.find((e) => e.id === id));
    if (items.some((x) => !x) || entries.some((e) => !e)) return refused('not-removed'); // never a silent partial selection
    const at = now();
    for (const [id, c] of cleanups) if (c.expiresAt < at) cleanups.delete(id);
    const own = scope === undefined ? [] : [...cleanups].filter(([, c]) => c.scope === scope).map(([id]) => id);
    if (cleanups.size - own.length >= MAX_PREVIEWS) return refused('busy');
    for (const id of own) cleanups.delete(id);
    const previewId = randomUUID();
    cleanups.set(previewId, { profiles, entries: structuredClone(entries as ManifestEntry[]), owner, expiresAt: at + TTL_MS, ...(scope === undefined ? {} : { scope }),
      real: (entries as ManifestEntry[]).some((e) => realEntry(e, denied, profiles)) });
    return { status: 'preview', previewId, ttlMs: TTL_MS, items: items.map((x) => ({ entry: x!.entry, cleanup: x!.cleanup })) };
  }

  /** Under the lock, taken before the lookup (busy keeps the preview). Every recheck and backup check runs before the first
   *  write (C3, C4); a failed record write after that is `partial`. ponytail (C6): `claude plugin` takes no Xaibo lock, so a
   *  reinstall between the last check and the manifest write leaves a plugin Xaibo no longer owns (Disconnect will not remove it). */
  async function applyCleanup(previewId: string, owner?: unknown): Promise<CleanupResult> {
    if (!denied) return refused('bounds-unavailable');
    const held = cleanups.get(previewId); // XAIBO-PROD-600: as applyConnect
    if (held && held.owner === owner && (held.real || held.entries.some((e) => realEntry(e, denied, held.profiles)))) return refused('needs-confirmation');
    return cleanupLocked(previewId, owner, false);
  }
  async function cleanupLocked(previewId: string, owner: unknown, confirmed: boolean): Promise<CleanupResult> {
    if (!denied) return refused('bounds-unavailable');
    return locked('service', (): CleanupResult => { // forgets records only, no CLI
      const h = cleanups.get(previewId);
      cleanups.delete(previewId);
      if (!h || h.owner !== owner) return refused('preview-invalid');
      if (now() > h.expiresAt) return refused('preview-expired');
      const r = current(h.profiles, true); // C1: our own lock
      if (r.status === 'blocked') return refused(r.code);
      let manifest: ManifestEntry[];
      try { manifest = readManifest(ctx.dataDir); } catch { return refused('manifest'); }
      // C2: the entry exactly as previewed and still removed by a fresh reconcile (which also reads the plugin registries)
      if (!h.entries.every((e) => isDeepStrictEqual(manifest.find((x) => x.id === e.id), e)
        && r.entries.some((x) => x.entry === e.id && x.state === 'disconnected-externally'))) return { status: 'needs-preview' };
      if (!confirmed && h.entries.some((e) => realEntry(e, denied, h.profiles))) return refused('needs-confirmation'); // review H1
      let todo: { id: string; file: string | null }[];
      try {
        const dir = privateDirs(ctx.dataDir).backups; // a linked or foreign backups dir refuses: private-dir
        todo = h.entries.map((e) => {
          if (e.backup === null) return { id: e.id, file: null };
          if (!BACKUP_NAME.test(e.backup)) fail('manifest');
          const file = path.join(dir, e.backup);
          let st;
          try { st = lstatSync(file); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { id: e.id, file: null }; throw err; }
          if (st.isSymbolicLink()) fail('symlink');
          if (!st.isFile() || (uid !== undefined && st.uid !== uid)) fail('not-regular');
          return { id: e.id, file };
        });
      } catch (err) { return refused(err instanceof ConfigError ? err.code : 'failed'); }
      const removed: string[] = [], left: string[] = [];
      const refresh = () => { try { latest = current(h.profiles, true); } catch { latest = null; } }; // code review 4: never lose removed/left
      // code review 3: backups are a fresh UUID per entry (apply, installPlugin); a hand-edited manifest sharing one with an
      // entry that stays keeps the file. ponytail (review 5): the backups dir is checked once above; a same-user swap of it for
      // a link before the unlink could remove a UUID-named .bak there (unlink never follows the final component).
      const kept = new Set(manifest.filter((x) => !h.entries.some((e) => e.id === x.id)).map((x) => x.backup));
      for (const { id, file } of todo) {
        try { dropEntry(ctx.dataDir, id); } catch (err) {
          refresh();
          return { status: 'partial', removed, left, code: err instanceof ConfigError ? err.code : 'failed' };
        }
        removed.push(id);
        if (file && !kept.has(path.basename(file))) {
          try { unlinkSync(file); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') left.push(id); } // an inert leftover
        }
      }
      refresh();
      return { status: 'cleaned', removed, left };
    });
  }

  // XAIBO-PROD-576 (P6-T10 unit 3; design R1/R4/R5; plan review H1, M1, M2, L1-L5): Disconnect (one profile's exact file and
  // routes) and Full Uninstall (every recorded entry) are previewed read-only and applied by preview id. A preview pins the
  // in-scope manifest entries, each target's identity {sha256, dev, ino, mode} and the items the owner saw (reconcile state
  // and profile mapping). A target outside the writable roots is never read (H1): pinned as refused and shown unreadable,
  // and revertAll leaves it. Apply, under the lock, writes nothing when any of it changed and answers a fresh preview.
  // Previews as Connect's (TTL, single use, owner-bound, max 32), one held per scope (M2).
  type Pin = { hash: string; dev: number; ino: number; mode: number } | null | 'refused' | { error: string };
  // XAIBO-PROD-580 (R6): `route` limits a profile's removal to one route (the separate tee off); its own scope
  const removals = new Map<string, { scope: string | null; profile: Profile | null; target: Target | null; route: Route | null; entries: ManifestEntry[]; pins: [string, Pin][]; items: RemovalItem[]; owner: unknown; expiresAt: number; real: boolean }>();
  const pinOf = (e: ManifestEntry, d: string[], profiles: readonly Profile[]): Pin => {
    const file = e.target;
    if (!entryBounds(e, d, profiles)) return 'refused';
    // diff review M1: a target that cannot be read safely (a link, not ours, too large) is named per target; revertAll stops there
    try { const f = readFile(file); return f ? { hash: sha256(f.bytes), dev: f.dev, ino: f.ino, mode: f.mode } : null; } catch (err) { if (err instanceof ConfigError) return { error: err.code }; throw err; }
  };
  type Scope = { entries: ManifestEntry[]; pins: [string, Pin][]; items: RemovalItem[] } | Refused;
  /** What a removal within target `t` (null: every entry) would touch now; read-only. `held`: the caller holds the lock. */
  function removalScope(profiles: readonly Profile[], t: Target | null, held: boolean, route: Route | null = null): Scope {
    const d = denied!;
    const r = current(profiles, held);
    if (r.status === 'blocked') return refused(r.code); // L3: busy, stale-lock, bounds-unavailable or manifest as they are
    let manifest: ManifestEntry[];
    try { manifest = readManifest(ctx.dataDir); } catch { return refused('manifest'); }
    const entries = t ? manifest.filter((e) => e.target === t.file && (route ? e.route === route : t.routes.includes(e.route))) : manifest;
    if (!entries.length) return refused('not-connected');
    // L4: never stored when it could not cross the wire. ponytail (diff review L4): more than 256 recorded entries refuses Full
    // Uninstall (a few per profile today); page it if that ever happens
    if (entries.length > REMOVAL_LIMIT) return refused('too-large');
    const pins = new Map<string, Pin>();
    try { for (const e of entries) if (!pins.has(e.target)) pins.set(e.target, pinOf(e, d, profiles)); } catch (err) { return refused(err instanceof ConfigError ? err.code : 'failed'); }
    const items = entries.map((e): RemovalItem => {
      const x = r.entries.find((y) => y.entry === e.id);
      const pin = pins.get(e.target);
      if (pin === 'refused') return { entry: e.id, route: e.route, profileId: x?.profileId ?? null, state: 'unreadable', reason: 'refused' };
      if (pin && 'error' in pin) return { entry: e.id, route: e.route, profileId: x?.profileId ?? null, state: 'unreadable', reason: pin.error };
      const state = x?.state ?? 'unreadable';
      return { entry: e.id, route: e.route, profileId: x?.profileId ?? null, state, reason: state === 'unreadable' ? (x?.reason ?? 'unreadable') : null };
    });
    return { entries, pins: [...pins], items };
  }
  function previewRemoval(profiles: readonly Profile[], p: Profile | null, owner?: unknown, held = false, route: Route | null = null): RemovalPreview | Refused {
    if (!denied) return refused('bounds-unavailable');
    if (route && !p) return refused('ops'); // a route limits one profile's removal only
    let t: Target | null = null;
    if (p) {
      t = targetFor(p);
      if (!t) return refused('unverified');
      if (!boundsFor(p, t)) return refusal(); // H1: before any read
    }
    const s = removalScope(profiles, t, held, route);
    if ('status' in s) return s;
    const at = now(), scope = p ? (route ? `${p.id}|${route}` : p.id) : null;
    for (const [id, h] of removals) if (h.expiresAt < at) removals.delete(id);
    const own = [...removals].filter(([, h]) => h.scope === scope).map(([id]) => id);
    if (removals.size - own.length >= MAX_PREVIEWS) return refused('busy'); // M2: checked before the scope's own is dropped
    for (const id of own) removals.delete(id);
    const previewId = randomUUID();
    removals.set(previewId, { scope, profile: p, target: t, route, entries: structuredClone(s.entries), pins: s.pins, items: s.items, owner, expiresAt: at + TTL_MS,
      real: s.entries.some((e) => realEntry(e, denied, profiles)) });
    return { status: 'preview', previewId, profileId: p?.id ?? null, ttlMs: TTL_MS, items: s.items };
  }
  /** `profiles`: the live synced profiles (M1: a profile gone since the preview changes the mapping). */
  async function applyRemoval(previewId: string, owner: unknown, profiles: readonly Profile[]): Promise<RemovalResult> {
    if (!denied) return refused('bounds-unavailable');
    const held = removals.get(previewId); // XAIBO-PROD-600: as applyConnect
    if (held && held.owner === owner && (held.real || held.entries.some((e) => realEntry(e, denied, profiles)))) return refused('needs-confirmation');
    return removalLocked(previewId, owner, profiles, false);
  }
  async function removalLocked(previewId: string, owner: unknown, profiles: readonly Profile[], confirmed: boolean): Promise<RemovalResult> {
    if (!denied) return refused('bounds-unavailable');
    const d = denied;
    return locked(writerOf(() => removals.get(previewId)?.entries ?? []), async (): Promise<RemovalResult> => {
      const h = removals.get(previewId);
      removals.delete(previewId); // consumed on first lookup, a wrong owner included
      if (!h || h.owner !== owner) return refused('preview-invalid');
      if (now() > h.expiresAt) return refused('preview-expired');
      // diff review L2: the live profile (same id, maybe a new root) for the recheck and the fresh preview
      const live = h.profile ? profiles.find((x) => x.id === h.profile!.id) : null;
      const again = (): RemovalResult => ({ status: 'needs-preview', preview: previewRemoval(profiles, live ?? null, owner, true, h.route) });
      if (h.profile) {
        if (!live) return refused('profile-not-found');
        const t = targetFor(live);
        if (!t || !boundsFor(live, t) || !isDeepStrictEqual(t, h.target)) return again(); // L2
      }
      const s = removalScope(profiles, h.target, true, h.route);
      if ('status' in s) return s.code === 'not-connected' ? again() : s;
      // R5, M1, L1: the same entries (deep-equal), target identities and items (state, profile) as previewed
      if (!isDeepStrictEqual(s.entries, h.entries) || !isDeepStrictEqual(s.pins, h.pins) || !isDeepStrictEqual(s.items, h.items)) return again();
      if (!confirmed && s.entries.some((e) => realEntry(e, d, profiles))) return refused('needs-confirmation'); // review H1
      return revertAll(s.entries, d, profiles);
    });
  }

  // XAIBO-PROD-600 (P6-T12 slice 2; D-P6-21; plan and security review .handoff/p6-t12-slice2-plan.md): main's native
  // confirmation of a real-class preview. applyOffer returns the dialog items (labels from a closed set) and a binding: an HMAC
  // under a per-start key over the kind, the preview id, the items and a digest of the held preview (everything apply would
  // use); applyConfirmed re-derives both from the held preview (never from main's text) and applies through the existing
  // locked path with the held owner (review M5: the only caller that may), so every recheck stays (needs-preview never applies).
  // XAIBO-PROD-613 (Phase 7 cleanup item 1, run 2; Codex design, D-P7-03, Claude simplification: no recovery-guard file): the
  // owner-confirmed Clear stale lock. A preview needs fresh evidence (the holder provably gone, a v2 record the service wrote)
  // and binds the canonical data dir, the lock file's identity and mode, a digest of its bytes and the record; it is held here
  // (the renderer sees only its id), single use, and applied only through main's confirmation (kind lock-clear). Immediately
  // before the unlink every bound value and the staleness are checked again; any change is lock-changed, never a retry.
  type LockEvidence = { dir: string; dev: number; ino: number; mode: number; digest: string; rec: unknown };
  const lockClears = new Map<string, LockEvidence & { owner: unknown; expiresAt: number }>();
  const lockPath = () => path.join(ctx.dataDir, 'integrations', 'operation.lock');
  function lockEvidence(): LockEvidence | Refused {
    let dir: string, f;
    try { privateDirs(ctx.dataDir); dir = realpathSync.native(ctx.dataDir); f = readFile(lockPath()); } catch { return refused('lock-unknown'); } // linked, not ours, unreadable
    if (!f) return refused('lock-free');
    let rec: unknown;
    try { rec = JSON.parse(f.bytes.toString('utf8')); } catch { return refused('lock-unknown'); }
    const state = judge(rec);
    if (state !== 'stale-lock') return refused(state);
    const r = rec as Record<string, unknown>;
    if (r['v'] !== 2 || r['writer'] !== 'service') return refused('lock-manual'); // an external CLI may still run: never in-app
    return { dir, dev: f.dev, ino: f.ino, mode: f.mode, digest: sha256(f.bytes), rec };
  }
  function previewLockClear(owner?: unknown): { status: 'preview'; previewId: string; ttlMs: number } | Refused {
    const ev = lockEvidence();
    if ('status' in ev) return ev;
    lockClears.clear(); // one lock, one held preview
    const previewId = randomUUID();
    lockClears.set(previewId, { ...ev, owner, expiresAt: now() + TTL_MS });
    return { status: 'preview', previewId, ttlMs: TTL_MS };
  }
  function clearLock(previewId: string): { status: 'cleared' } | Refused {
    const h = lockClears.get(previewId);
    lockClears.delete(previewId); // single use
    if (!h) return refused('preview-invalid');
    if (now() > h.expiresAt) return refused('preview-expired');
    const ev = lockEvidence();
    if ('status' in ev || ev.dir !== h.dir || ev.dev !== h.dev || ev.ino !== h.ino || ev.mode !== h.mode || ev.digest !== h.digest) return refused('lock-changed');
    // ponytail: the lstat-checked path is then unlinked by name; a replacement in that microsecond window needs the stale file
    // removed by hand first (acquire is O_EXCL), so only a concurrent manual removal could race it
    try { unlinkSync(lockPath()); } catch { return refused('lock-changed'); }
    previews.clear(); removals.clear(); cleanups.clear(); // every held integration preview: made under the old lock state
    return { status: 'cleared' };
  }

  const applyKey = randomBytes(32);
  type Offered = { items: [ApplyLabel, string][]; digest: string; owner: unknown; run: () => Promise<unknown> };
  function offered(kind: ApplyKind, previewId: string, profiles: readonly Profile[]): Offered | Refused {
    if (kind === 'lock-clear') { // XAIBO-PROD-613: touches no agent configuration, so no bounds; reconcile afterwards (read-only)
      const l = lockClears.get(previewId);
      if (!l) return refused('preview-invalid');
      if (now() > l.expiresAt) return refused('preview-expired');
      const bound: LockEvidence = { dir: l.dir, dev: l.dev, ino: l.ino, mode: l.mode, digest: l.digest, rec: l.rec };
      return { items: [['scope', 'Every integration in this Xaibo data folder'], ['file', lockPath()]], digest: JSON.stringify(bound), owner: l.owner,
        // review LOW: the clear already happened; a failing read-only reconcile must not turn it into unknown
        run: async () => { const r = clearLock(previewId); if (r.status === 'cleared' && denied) { try { reconcile(profiles); } catch { /* the panel's next read reconciles */ } } return r; } };
    }
    if (!denied) return refused('bounds-unavailable');
    const d = denied, at = now();
    if (kind === 'connect') {
      const h = previews.get(previewId);
      if (!h) return refused('preview-invalid');
      if (at > h.expiresAt) return refused('preview-expired');
      if (!h.real && !nowReal(h.profile)) return refused('not-real');
      const p = h.profile, items: [ApplyLabel, string][] = [['agent', p.agent], ['profile', p.id], ['folder', p.root]];
      for (const s of h.steps) {
        items.push(['file', s.plan.target], ['change', `${s.route}: ${s.plan.preHash === null ? 'create' : 'modify'}, ${s.plan.owned.length} owned, ${s.plan.created.length} created`]);
        for (const o of s.plan.owned) items.push(['value', `${o.pointer} = ${JSON.stringify(o.value)}`]); // code review 1: what is written, hook commands included
      }
      if (h.retention?.offered && h.steps.some((s) => s.route === 'claude-retention')) items.push(['retention', `${h.retention.from ?? 'not set'} to ${h.retention.to} days`]);
      if (p.agent === 'claude') items.push(['tee', h.steps.some((s) => s.route === 'claude-tee') ? 'on' : 'off']);
      items.push(['helper', shimPath(ctx.dataDir)]);
      // code review 4: the plugin preview too (never built for a real profile today, decision A; bound if that ever changes)
      const digest = JSON.stringify({ p, sel: h.sel, report: h.report, trust: h.trust, retention: h.retention, plugin: h.plugin?.pp ?? null,
        steps: h.steps.map((s) => ({ route: s.route, target: s.plan.target, owned: s.plan.owned, created: s.plan.created, preHash: s.plan.preHash, dev: s.plan.dev, ino: s.plan.ino, mode: s.plan.mode })) });
      return { items, digest, owner: h.owner, run: () => locked(h.plugin ? 'external' : 'service', () => applyLocked(previewId, h.owner, true)) };
    }
    if (kind === 'removal') {
      const r = removals.get(previewId);
      if (!r) return refused('preview-invalid');
      if (at > r.expiresAt) return refused('preview-expired');
      const real = r.entries.filter((e) => realEntry(e, d, profiles)).length;
      if (!r.real && !real) return refused('not-real');
      const items: [ApplyLabel, string][] = r.profile ? [['agent', r.profile.agent], ['profile', r.profile.id], ['folder', r.profile.root]] : [['scope', 'Full Uninstall: every recorded entry']];
      items.push(['entries', String(r.entries.length)], ['real-entries', String(real)]);
      for (const e of r.entries) items.push(['file', e.target], ['change', `${e.route}: revert`]);
      const digest = JSON.stringify({ scope: r.scope, profile: r.profile, target: r.target, route: r.route, entries: r.entries, pins: r.pins, items: r.items });
      return { items, digest, owner: r.owner, run: () => removalLocked(previewId, r.owner, profiles, true) };
    }
    const c = cleanups.get(previewId);
    if (!c) return refused('preview-invalid');
    if (at > c.expiresAt) return refused('preview-expired');
    if (!c.real && !c.entries.some((e) => realEntry(e, d, c.profiles))) return refused('not-real');
    const scan = current(c.profiles, false);
    if (scan.status === 'blocked') return refused(scan.code === 'bounds-unavailable' || scan.code === 'manifest' ? 'failed' : scan.code); // review LOW 2: lock codes as they are
    const items: [ApplyLabel, string][] = [...(c.scope ? [['profile', c.scope] as [ApplyLabel, string]] : []), ['records', String(c.entries.length)], ['backups', String(c.entries.filter((e) => e.backup).length)]];
    for (const e of c.entries) {
      items.push(['file', e.target], ['change', `${e.route}: forget the record`]);
      const manual = scan.entries.find((x) => x.entry === e.id)?.manual ?? [];
      if (manual.length) items.push(['manual', manual.join(', ')]);
    }
    return { items, digest: JSON.stringify({ scope: c.scope ?? null, entries: c.entries }), owner: c.owner, run: () => cleanupLocked(previewId, c.owner, true) };
  }
  const bindingOf = (kind: ApplyKind, previewId: string, x: Offered) => createHmac('sha256', applyKey).update(JSON.stringify([kind, previewId, x.items, x.digest])).digest('hex');
  function applyOffer(kind: ApplyKind, previewId: string, profiles: readonly Profile[]): { status: 'offer'; offer: ApplyOffer } | Refused {
    const x = offered(kind, previewId, profiles);
    if ('status' in x) return x;
    if (x.items.length > APPLY_ITEMS || x.items.some(([, v]) => v.length > 4096)) return refused('oversize'); // ponytail: a very large Full Uninstall is refused until chunked
    return { status: 'offer', offer: { kind, previewId, items: x.items, binding: bindingOf(kind, previewId, x) } };
  }
  async function applyConfirmed(kind: ApplyKind, previewId: string, binding: string, profiles: readonly Profile[]): Promise<{ status: 'done'; reply: unknown } | Refused> {
    const x = offered(kind, previewId, profiles);
    if ('status' in x) return x;
    const want = Buffer.from(bindingOf(kind, previewId, x)), got = Buffer.from(binding);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return refused('stale'); // the held preview stays for a fresh offer
    return { status: 'done', reply: await x.run() };
  }

  return { previewConnect, applyConnect, disconnect, uninstall, dropOwner, reconcile, reconciled, previewCleanup, applyCleanup, previewRemoval, applyRemoval, applyOffer, applyConfirmed, previewLockClear };
}
