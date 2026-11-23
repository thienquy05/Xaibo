// XAIBO-PROD-557 (P6-T03 part 1a; FR-30..FR-34, FR-45, EC-48, EC-73; design: Codex, .handoff/p6-t03-design.md; owner D-P6-06):
// Connect, Disconnect and Uninstall over the FR-32 engine routes, for disposable profiles only (real profiles: P6-T12).
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
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isProfileKey } from '../../shared/hook-protocol.ts';
import { agyHooksFile, checkAgyInstall } from '../adapters/agy/setup.ts';
import { deployShim, installPlugin, PLUGIN_REF, pluginHooks, previewPlugin, teePlan, uninstallPlugin, type PluginOptions, type PluginPreview } from '../adapters/claude/setup.ts';
import { codexHookOps, codexTrustSteps, shimPath } from '../adapters/codex/setup.ts';
import type { Detection, Profile } from '../catalog/detect.ts';
import type { Catalog } from '../catalog/validate.ts';
import { claudeConnectRoute, claudeRetentionOffer, retentionOps, type RetentionOffer } from '../catalog/setup-plans.ts';
import { real, writable } from '../config/bounds.ts';
import { acquireLock, lockState } from '../config/lock.ts';
import {
  apply, ConfigError, plan, readFile, readManifest, revert, type Bounds, type DiffLine, type ManifestEntry, type Op, type Plan, type Route,
} from '../config/transaction.ts';
import { reconcile as scan, runsShim, XAIBO_SHIM, type ReconcileReport, type Target } from './reconcile.ts';

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
  /** Monotonic ms (default performance.now). */
  now?: () => number;
  /** Test only (part 2a review L4): passed to the engine's apply() to inject a failure after a step's rename. The service's
   *  connectContext() never sets it. */
  afterRename?: (file: string) => void;
}
export interface Selections { retention: boolean; tee: boolean }
/** cli (the plugin step only): the detected version, the argv with the plugin folder as `<plugin-dir>` (review H2) and what
 *  the CLI writes, relative to the config dir. */
export interface StepView { route: Route; target: string; diff: DiffLine[]; cli?: { version: string; argv: string[][]; writes: string[] } }
export type Refused = { status: 'refused'; code: string };
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

/** Design review H1: each agent's exact file and routes, used by preview and by Disconnect (never "anything under the root"). */
function targetOf(p: Profile): Target | null {
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
  steps: { route: Route; build: () => Plan; plan: Plan }[]; trust: string[]; expiresAt: number;
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
  const previews = new Map<string, Held>();
  const recorded = (file: string, routes: Route[]) => readManifest(ctx.dataDir).some((e) => e.target === file && routes.includes(e.route));

  /** Selections, profile key and helper paths are captured here, never taken from an apply request (review L1). */
  function builders(p: Profile, t: Target, sel: Selections): { plugin: Plugin | null; list: Builder[]; retention: RetentionOffer | null; trust: string[] } {
    const key = isProfileKey(p.id) ? p.id : fail('ops');
    const bounds: Bounds = { root: t.dir, denied: denied! };
    const shim = shimPath(ctx.dataDir);
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
    const route = ctx.catalog ? claudeConnectRoute(ctx.catalog, d) : null; // D-2, D-P6-07: no chooser, never a fallback after a failure
    if (!route || d?.state !== 'detected') return fail('unverified');
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
    const t = targetOf(p);
    if (!t) return refused('unverified');
    if (!permitted(t)) return refused('real-profile'); // before any offer read (review H3, M4)
    if (p.agent === 'claude' && !ctx.cliPath) return refused('bounds-unavailable'); // no login PATH: like no denylist
    // part 1b review M2: the helpers apply will deploy exist, before the owner confirms (xaibo-report ships beside the hook)
    const helpers = [ctx.helpers.hook, path.join(path.dirname(ctx.helpers.hook), 'xaibo-report'), ctx.helpers.forwarder, ...(sel.tee ? [ctx.helpers.statusline] : [])];
    if (!helpers.every(regularFile)) return refused('helpers-unavailable');
    let b, steps, pp: PluginPreview | null = null;
    try {
      b = builders(p, t, sel);
      if (b.plugin) pp = previewPlugin(b.plugin.o); // nothing runs, nothing is written
      steps = b.list.map(([route, build]) => ({ route, build, plan: build() }));
    } catch (e) { if (e instanceof ConfigError) return refused(e.code); throw e; }
    const at = now();
    for (const [id, h] of previews) if (h.expiresAt < at) previews.delete(id);
    const own = [...previews].filter(([, h]) => h.profile.id === p.id).map(([id]) => id);
    if (previews.size - own.length >= MAX_PREVIEWS) return refused('busy'); // checked before the profile's own is dropped
    for (const id of own) previews.delete(id); // one per profile
    const previewId = randomUUID();
    previews.set(previewId, { profile: p, sel, owner, plugin: b.plugin && pp ? { o: b.plugin.o, pp } : null, steps, trust: b.trust, expiresAt: at + TTL_MS });
    const views: StepView[] = steps.map((s) => ({ route: s.route, target: s.plan.target, diff: s.plan.diff }));
    return {
      status: 'preview', previewId, profileId: p.id, ttlMs: TTL_MS, steps: b.plugin && pp ? [pluginView(pp, b.plugin.version), ...views] : views,
      retention: b.retention, trustSteps: b.trust,
    };
  }

  /** Design review M3: stricter than the redacted diff: route, target, owned values with the full value they replace, created. */
  const same = (a: Plan, b: Plan) => a.route === b.route && a.target === b.target && isDeepStrictEqual(a.owned, b.owned) && isDeepStrictEqual(a.created, b.created);

  /** Part 2a: under the operation lock, taken before the preview is looked up, so `busy` keeps the preview for a retry. */
  async function applyConnect(previewId: string, owner?: unknown): Promise<ConnectResult> {
    if (!denied) return refused('bounds-unavailable');
    return locked(() => applyLocked(previewId, owner));
  }
  /** The operation lock around one whole operation, held until its promise settles (part 2b: the CLI awaits); a held or stale
   *  lock is the refusal, nothing else is touched. */
  async function locked<T>(fn: () => T | Promise<T>): Promise<T | Refused> {
    let lock;
    try { lock = acquireLock(ctx.dataDir); } catch (e) { return refused(e instanceof ConfigError ? e.code : 'failed'); } // nothing written yet (code review L-b)
    try { return await fn(); } finally { lock.release(); }
  }
  async function applyLocked(previewId: string, owner?: unknown): Promise<ConnectResult> {
    const h = previews.get(previewId);
    previews.delete(previewId); // consumed on first lookup, whatever happens next, a wrong owner included (review L1, 1b L5)
    if (!h || h.owner !== owner) return refused('preview-invalid');
    if (now() > h.expiresAt) return refused('preview-expired');
    if (!denied) return refused('bounds-unavailable');
    const t = targetOf(h.profile);
    if (!t || !permitted(t)) return refused('real-profile');
    const again = (): ConnectResult => ({ status: 'needs-preview', preview: preview(h.profile, h.sel, h.owner) }); // 1b review M1; we hold the lock
    // checked before any helper is deployed: bytes, file identity and mode, as apply() / installPlugin will (review L2)
    const first = h.plugin ? h.plugin.pp.settings : h.steps[0]!.plan.preHash === null ? null : { hash: h.steps[0]!.plan.preHash, dev: h.steps[0]!.plan.dev, ino: h.steps[0]!.plan.ino, mode: h.steps[0]!.plan.mode };
    const cur = readFile(h.plugin ? h.plugin.pp.target : h.steps[0]!.plan.target);
    if (!isDeepStrictEqual(cur ? { hash: sha256(cur.bytes), dev: cur.dev, ino: cur.ino, mode: cur.mode } : null, first)) return again();
    deployShim(ctx.dataDir, { hook: ctx.helpers.hook, forwarder: ctx.helpers.forwarder, ...(h.steps.some((s) => s.route === 'claude-tee') ? { statusline: ctx.helpers.statusline } : {}) });
    const done: ManifestEntry[] = [];
    const undo = async (code: string | null, extra: ManifestEntry[] = []): Promise<ConnectResult> => {
      const u = await revertAll([...done, ...extra], denied);
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
      try { done.push(apply(next, { dataDir: ctx.dataDir, bounds: { root: t.dir, denied }, ...(ctx.afterRename ? { afterRename: ctx.afterRename } : {}) })); } catch (e) {
        // review M1: a step that threw after recording its entry leaves a pending entry: it is undone first
        const residue = readManifest(ctx.dataDir).filter((x) => !known.has(x.id));
        return await undo(e instanceof ConfigError ? e.code : 'failed', residue);
      }
    }
    return { status: 'applied', entries: done.map((e) => e.id), trustSteps: h.trust };
  }

  /** Newest first (manifest order is creation order, review M2); per entry: writable roots (review H3), then stop rules (L3). */
  async function revertAll(list: ManifestEntry[], d: string[]): Promise<Outcome> {
    const out: Outcome = { status: 'disconnected', reverted: [], conflicts: [], remaining: [] };
    const stopped = new Set<string>();
    for (const e of [...list].reverse()) {
      const at = { entry: e.id, route: e.route }, dir = path.dirname(e.target);
      const stop = (reason: string) => { out.remaining.push({ ...at, reason }); stopped.add(e.target); };
      if (!writable(dir, ctx.allowed, d)) { stop('refused'); continue; }
      if (stopped.has(e.target)) { out.remaining.push({ ...at, reason: 'blocked' }); continue; }
      if (e.route === 'claude-plugin') { await removePlugin(e, dir, d, out, stop, () => stopped.add(e.target)); continue; }
      try {
        const r = revert(e, { dataDir: ctx.dataDir, bounds: { root: real(dir), denied: d } });
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

  async function disconnect(p: Profile): Promise<Outcome | Refused> {
    if (!denied) return refused('bounds-unavailable');
    const t = targetOf(p);
    if (!t) return refused('unverified');
    return locked(() => revertAll(readManifest(ctx.dataDir).filter((e) => e.target === t.file && t.routes.includes(e.route)), denied));
  }

  /** Every recorded entry, including profiles no longer detected; history and the shim stay (FR-34; orphan shim: P6-T05). */
  const uninstall = async (): Promise<Outcome | Refused> => (denied ? locked(() => revertAll(readManifest(ctx.dataDir), denied)) : refused('bounds-unavailable'));

  /** A closed port's previews can never be applied: drop them (part 1b review L5). */
  const dropOwner = (owner: unknown) => { for (const [id, h] of previews) if (h.owner === owner) previews.delete(id); };

  /** XAIBO-PROD-562 (P6-T04 part 1, EC-26): the read-only reconcile over the current profiles; the latest report is kept for
   *  the IPC read (P6-T10). Same denylist and writable roots as every write. */
  // ponytail (code review 6): kept for its first reader, the P6-T10 IPC read; only tests read it until then
  let latest: ReconcileReport | null = null;
  const reconcile = (profiles: readonly Profile[]) => (latest = scan({ dataDir: ctx.dataDir, denied, profiles, target: targetOf, permitted }));
  const reconciled = () => latest;

  return { previewConnect, applyConnect, disconnect, uninstall, dropOwner, reconcile, reconciled };
}
