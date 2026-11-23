// XAIBO-PROD-557 (P6-T03 part 1a; FR-30..FR-34, FR-45, EC-48, EC-73; design: Codex, .handoff/p6-t03-design.md; owner D-P6-06):
// Connect, Disconnect and Uninstall over the FR-32 engine routes, for disposable profiles only (real profiles: P6-T12).
// previewConnect builds a profile's steps (Claude: settings-fallback hooks, then the retention raise, then the default-off
// tee; Codex: hooks plus guided trust steps, trust never written; agy: hooks; Gemini: not offered until S11) and holds them
// in memory by preview id. applyConnect applies step 1's stored Plan unchanged and rebuilds each later step, applying it
// only if it equals the previewed one (route, target, owned values with what they replace, created keys); otherwise, or when
// a step fails, this Connect is undone newest first and a new preview is shown. Disconnect and Uninstall revert newest
// first, each entry bounds-checked on its own, and stop on a target after a conflict, refusal or error.
// ponytail: synchronous, so the service's one thread serializes these; part 2's `claude plugin` awaits need an in-process
// mutex and a lock file shared with the dev CLI (transaction.ts lock note).
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isProfileKey } from '../../shared/hook-protocol.ts';
import { agyHooksFile, checkAgyInstall } from '../adapters/agy/setup.ts';
import { deployShim, pluginHooks, teePlan } from '../adapters/claude/setup.ts';
import { codexHookOps, codexTrustSteps, shimPath } from '../adapters/codex/setup.ts';
import type { Profile } from '../catalog/detect.ts';
import { claudeRetentionOffer, retentionOps, type RetentionOffer } from '../catalog/setup-plans.ts';
import { real, writable } from '../config/bounds.ts';
import {
  apply, ConfigError, plan, readFile, readManifest, revert, type Bounds, type DiffLine, type ManifestEntry, type Op, type Plan, type Route,
} from '../config/transaction.ts';

export interface ConnectContext {
  dataDir: string;
  /** Real agent roots (bounds.ts deniedRootsFrom); null or empty (login environment unreadable) refuses every call. */
  denied: string[] | null;
  /** Disposable roots a profile must be strictly below (bounds.ts writable). */
  allowed: string[];
  claudeManagedDir: string;
  /** The bundled helpers deployShim copies (xaibo-report sits beside `hook`). */
  helpers: { hook: string; forwarder: string; statusline: string };
  /** Monotonic ms (default performance.now). */
  now?: () => number;
}
export interface Selections { retention: boolean; tee: boolean }
export interface StepView { route: Route; target: string; diff: DiffLine[] }
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
const XAIBO_SHIM = (agent: string) => new RegExp(`xaibo-hook['"]?\\s+hook\\s+${agent}(\\s|$)`); // whatever its quoting
const fail = (code: ConfigError['code']): never => { throw new ConfigError(code); };
const refused = (code: string): Refused => ({ status: 'refused', code });
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Target { dir: string; file: string; routes: Route[] }
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
function runsShim(doc: unknown, shim: RegExp): boolean {
  if (Array.isArray(doc)) return doc.some((x) => runsShim(x, shim));
  if (typeof doc !== 'object' || doc === null) return false;
  const o = doc as Record<string, unknown>;
  if (o['type'] === 'command' && typeof o['command'] === 'string' && shim.test(o['command'])) return true;
  return Object.values(o).some((x) => runsShim(x, shim));
}
/** Design review H2: hooks already running a Xaibo shim (even with the manifest lost) are never appended again. */
function noShim(file: string, agent: string) {
  const cur = readFile(file);
  if (!cur) return;
  let doc: unknown;
  try { doc = JSON.parse(cur.bytes.toString('utf8')); } catch { return fail('invalid-json'); }
  if (runsShim(doc, XAIBO_SHIM(agent))) fail('duplicate');
}

type Builder = [Route, () => Plan];
interface Held { profile: Profile; sel: Selections; steps: { route: Route; build: () => Plan; plan: Plan }[]; trust: string[]; expiresAt: number }

export function createConnect(ctx: ConnectContext) {
  const now = ctx.now ?? (() => performance.now());
  // code review M-c: no denylist means the real roots are unknown: refuse every call, never fail open
  const denied = ctx.denied?.length ? ctx.denied : null;
  /** The profile's own dir and the folder of the file written are both private and disposable (code review M-d: agy). */
  const permitted = (t: Target) => !!denied && writable(t.dir, ctx.allowed, denied) && writable(path.dirname(t.file), ctx.allowed, denied);
  const previews = new Map<string, Held>();
  const recorded = (file: string, routes: Route[]) => readManifest(ctx.dataDir).some((e) => e.target === file && routes.includes(e.route));

  /** Selections, profile key and helper paths are captured here, never taken from an apply request (review L1). */
  function builders(p: Profile, t: Target, sel: Selections): { list: Builder[]; retention: RetentionOffer | null; trust: string[] } {
    const key = isProfileKey(p.id) ? p.id : fail('ops');
    const bounds: Bounds = { root: t.dir, denied: denied! };
    const shim = shimPath(ctx.dataDir);
    if (p.agent === 'codex') {
      return { list: [['codex-hooks', () => {
        if (recorded(t.file, ['codex-hooks'])) fail('duplicate');
        noShim(t.file, 'codex');
        return plan(t.file, 'codex-hooks', codexHookOps(shim, key), bounds);
      }]], retention: null, trust: codexTrustSteps(t.dir, shim, key) };
    }
    if (p.agent === 'agy') {
      return { list: [['agy-hooks', () => { const c = checkAgyInstall({ dataDir: ctx.dataDir, profileKey: key, profileHome: t.dir, bounds }); return plan(c.file, 'agy-hooks', c.ops, bounds); }]],
        retention: null, trust: [] }; // ponytail: no project selected, so a project's .agents/hooks.json is not inspected
    }
    const list: Builder[] = [['claude-settings-fallback', () => {
      if (recorded(t.file, ['claude-plugin', 'claude-settings-fallback'])) fail('duplicate');
      noShim(t.file, 'claude');
      return plan(t.file, 'claude-settings-fallback', fallbackOps(shim, key), bounds);
    }]];
    // ponytail: a partial (conflicted) retention entry keeps the offer at `connected` until Disconnect resolves it (P6-T02)
    const retention = claudeRetentionOffer(t.dir, ctx.claudeManagedDir, readManifest(ctx.dataDir));
    if (sel.retention && retention.offered) {
      list.push(['claude-retention', () => {
        const ops = retentionOps(claudeRetentionOffer(t.dir, ctx.claudeManagedDir, readManifest(ctx.dataDir)));
        return ops.length ? plan(t.file, 'claude-retention', ops, bounds) : fail('retention'); // no longer offered: a mismatch
      }]);
    }
    if (sel.tee) list.push(['claude-tee', () => teePlan({ dataDir: ctx.dataDir, profileKey: key, configDir: t.dir, bounds })]);
    return { list, retention, trust: [] };
  }

  function previewConnect(p: Profile, sel: Selections): Preview | Refused {
    if (!denied) return refused('bounds-unavailable');
    const t = targetOf(p);
    if (!t) return refused('unverified');
    if (!permitted(t)) return refused('real-profile'); // before any offer read (review H3, M4)
    let b, steps;
    try {
      b = builders(p, t, sel);
      steps = b.list.map(([route, build]) => ({ route, build, plan: build() }));
    } catch (e) { if (e instanceof ConfigError) return refused(e.code); throw e; }
    const at = now();
    for (const [id, h] of previews) if (h.expiresAt < at) previews.delete(id);
    const own = [...previews].filter(([, h]) => h.profile.id === p.id).map(([id]) => id);
    if (previews.size - own.length >= MAX_PREVIEWS) return refused('busy'); // checked before the profile's own is dropped
    for (const id of own) previews.delete(id); // one per profile
    const previewId = randomUUID();
    previews.set(previewId, { profile: p, sel, steps, trust: b.trust, expiresAt: at + TTL_MS });
    return { status: 'preview', previewId, profileId: p.id, ttlMs: TTL_MS, steps: steps.map((s) => ({ route: s.route, target: s.plan.target, diff: s.plan.diff })), retention: b.retention, trustSteps: b.trust };
  }

  /** Design review M3: stricter than the redacted diff: route, target, owned values with the full value they replace, created. */
  const same = (a: Plan, b: Plan) => a.route === b.route && a.target === b.target && isDeepStrictEqual(a.owned, b.owned) && isDeepStrictEqual(a.created, b.created);

  function applyConnect(previewId: string): ConnectResult {
    const h = previews.get(previewId);
    previews.delete(previewId); // consumed on first lookup, whatever happens next (review L1)
    if (!h) return refused('preview-invalid');
    if (now() > h.expiresAt) return refused('preview-expired');
    if (!denied) return refused('bounds-unavailable');
    const t = targetOf(h.profile);
    if (!t || !permitted(t)) return refused('real-profile');
    const again = (): ConnectResult => ({ status: 'needs-preview', preview: previewConnect(h.profile, h.sel) });
    // checked before any helper is deployed: bytes, file identity and mode, as apply() will (review L2)
    const first = h.steps[0]!.plan, cur = readFile(first.target);
    if ((cur ? sha256(cur.bytes) : null) !== first.preHash || (cur && (cur.dev !== first.dev || cur.ino !== first.ino || cur.mode !== first.mode))) return again();
    deployShim(ctx.dataDir, { hook: ctx.helpers.hook, forwarder: ctx.helpers.forwarder, ...(h.steps.some((s) => s.route === 'claude-tee') ? { statusline: ctx.helpers.statusline } : {}) });
    const done: ManifestEntry[] = [];
    const undo = (code: string | null, extra: ManifestEntry[] = []): ConnectResult => {
      const u = revertAll([...done, ...extra], denied);
      if (u.status === 'partial') return { ...u, status: 'partial', code: code ?? 'mismatch' };
      return code === null ? again() : refused(code);
    };
    for (const [i, step] of h.steps.entries()) {
      let next: Plan;
      try { next = i === 0 ? step.plan : step.build(); } catch (e) { return undo(e instanceof ConfigError ? null : 'failed'); } // code review M-a
      if (i > 0 && !same(next, step.plan)) return undo(null);
      const known = new Set(readManifest(ctx.dataDir).map((e) => e.id));
      try { done.push(apply(next, { dataDir: ctx.dataDir, bounds: { root: t.dir, denied } })); } catch (e) {
        // review M1: a step that threw after recording its entry leaves a pending entry: it is undone first
        const residue = readManifest(ctx.dataDir).filter((x) => !known.has(x.id));
        return undo(e instanceof ConfigError ? e.code : 'failed', residue);
      }
    }
    return { status: 'applied', entries: done.map((e) => e.id), trustSteps: h.trust };
  }

  /** Newest first (manifest order is creation order, review M2); per entry: writable roots (review H3), then stop rules (L3). */
  function revertAll(list: ManifestEntry[], d: string[]): Outcome {
    const out: Outcome = { status: 'disconnected', reverted: [], conflicts: [], remaining: [] };
    const stopped = new Set<string>();
    for (const e of [...list].reverse()) {
      const at = { entry: e.id, route: e.route }, dir = path.dirname(e.target);
      const stop = (reason: string) => { out.remaining.push({ ...at, reason }); stopped.add(e.target); };
      if (!writable(dir, ctx.allowed, d)) { stop('refused'); continue; }
      if (stopped.has(e.target)) { out.remaining.push({ ...at, reason: 'blocked' }); continue; }
      if (e.route === 'claude-plugin') { stop('plugin'); continue; } // ponytail: uninstalls through `claude plugin` in part 2
      try {
        const r = revert(e, { dataDir: ctx.dataDir, bounds: { root: real(dir), denied: d } });
        out.reverted.push({ ...at, result: r.result });
        if (r.conflicts.length) { out.conflicts.push(...r.conflicts.map((c) => ({ ...at, pointer: c.pointer }))); stopped.add(e.target); }
      } catch (err) { stop(err instanceof ConfigError ? err.code : 'failed'); }
    }
    if (out.conflicts.length || out.remaining.length) out.status = 'partial';
    return out;
  }

  function disconnect(p: Profile): Outcome | Refused {
    if (!denied) return refused('bounds-unavailable');
    const t = targetOf(p);
    if (!t) return refused('unverified');
    return revertAll(readManifest(ctx.dataDir).filter((e) => e.target === t.file && t.routes.includes(e.route)), denied);
  }

  /** Every recorded entry, including profiles no longer detected; history and the shim stay (FR-34; orphan shim: P6-T05). */
  const uninstall = (): Outcome | Refused => (denied ? revertAll(readManifest(ctx.dataDir), denied) : refused('bounds-unavailable'));

  return { previewConnect, applyConnect, disconnect, uninstall };
}
