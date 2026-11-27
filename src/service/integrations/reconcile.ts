// XAIBO-PROD-562 (P6-T04 part 1; EC-26; design .handoff/p6-t04-design.md: Codex, fresh security review adopted; owner D-P6-08):
// a read-only reconcile of the FR-32 manifest against each current disposable profile's config. Per entry: connected (every
// owned value still there), disconnected-externally (all gone: removed outside Xaibo), drifted (some gone, one changed, or a
// partial entry), pending-recovery (a step never finished: reported, never repaired), unreadable (no current profile, outside
// the writable disposable roots, or evidence that cannot be read safely). Nothing is written, no lock is taken, no CLI runs;
// a held or stale operation lock blocks the whole scan. Only a removed entry offers cleanup (its manifest record and backup,
// part 2); the plugin copy and a still-registered marketplace are listed as manual (review R1: P6-T12).
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isProfileKey } from '../../shared/hook-protocol.ts';
import { isObj } from '../../shared/ipc.ts';
import { pluginEvidence } from '../adapters/claude/setup.ts';
import type { Profile } from '../catalog/detect.ts';
import { lockState } from '../config/lock.ts';
import { BACKUP_NAME, ConfigError, readFile, readManifest, segments, type ManifestEntry, type Route } from '../config/transaction.ts';

export type ReconcileState = 'connected' | 'disconnected-externally' | 'drifted' | 'pending-recovery' | 'unreadable';
export type Leftover = 'manifest-entry' | 'backup' | 'plugin-copy' | 'marketplace';
/** Fixed enums and ids only, never a path or a value (review R9). reason: unreadable only (a ConfigError code,
 *  `refused` or `profile-unavailable`). */
export interface Reconciled {
  entry: string; route: Route; profileId: string | null; state: ReconcileState; reason?: string; cleanup: Leftover[]; manual: Leftover[];
}
export type ReconcileReport = { status: 'ready'; entries: Reconciled[] } | { status: 'blocked'; code: 'busy' | 'stale-lock' | 'bounds-unavailable' | 'manifest' };
export interface Target { dir: string; file: string; routes: Route[] }

/** Any Xaibo hook shim for `agent`, whatever its quoting (moved from connect.ts). */
export const XAIBO_SHIM = (agent: string) => new RegExp(`xaibo-hook['"]?\\s+hook\\s+${agent}(\\s|$)`);
export function runsShim(doc: unknown, shim: RegExp): boolean {
  if (Array.isArray(doc)) return doc.some((x) => runsShim(x, shim));
  if (typeof doc !== 'object' || doc === null) return false;
  const o = doc as Record<string, unknown>;
  if (o['type'] === 'command' && typeof o['command'] === 'string' && shim.test(o['command'])) return true;
  return Object.values(o).some((x) => runsShim(x, shim));
}

const INDEX = /^(0|[1-9]\d*)$/;
const AGENT: Record<Route, string> = {
  'claude-plugin': 'claude', 'claude-settings-fallback': 'claude', 'claude-retention': 'claude', 'claude-tee': 'claude', 'codex-hooks': 'codex', 'agy-hooks': 'agy',
  'report-setup': 'report', // XAIBO-PROD-589: set ops only, so no hook-array matching (no shim is named 'report')
};
const exists = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
const at = (doc: unknown, segs: string[]): unknown => segs.reduce<unknown>((v, k) => (Array.isArray(v) || isObj(v) ? (v as Record<string, unknown>)[k] : undefined), doc);

/** Each owned value: an appended hook group is found anywhere in its event array by deep equality (foreign edits shift
 *  positions, EC-72); a missing group beside another Xaibo group there was changed, not removed (review R5). A set value
 *  is present, gone (absent, or the value it replaced is back) or changed. Any change, or a mix, is drift. */
function values(e: ManifestEntry): ReconcileState {
  const cur = readFile(e.target);
  if (!cur) return 'disconnected-externally';
  let doc: unknown;
  try { doc = JSON.parse(cur.bytes.toString('utf8')); } catch { throw new ConfigError('invalid-json'); }
  const shim = XAIBO_SHIM(AGENT[e.route]);
  const seen = e.owned.map((o) => {
    const segs = segments(o.pointer), last = segs.at(-1)!, parent = at(doc, segs.slice(0, -1));
    if (Array.isArray(parent) && INDEX.test(last)) return parent.some((x) => isDeepStrictEqual(x, o.value)) ? 'present' : runsShim(parent, shim) ? 'changed' : 'gone';
    if (!isObj(parent) || !Object.hasOwn(parent, last)) return 'gone';
    if (isDeepStrictEqual(parent[last], o.value)) return 'present';
    return 'old' in o && isDeepStrictEqual(parent[last], o.old) ? 'gone' : 'changed';
  });
  if (seen.every((s) => s === 'present')) return 'connected';
  return seen.every((s) => s === 'gone') ? 'disconnected-externally' : 'drifted';
}

/** D-P6-08: removed only when the enabled key is gone and the plugin is no longer registered; an owner's `false` (or any
 *  other value) is drift (review R4). */
function plugin(t: Target, copy: string | null) {
  const ev = pluginEvidence(t.dir, copy ?? '');
  const state: ReconcileState = ev.enabled === undefined && !ev.installed ? 'disconnected-externally'
    : ev.enabled === true && ev.installed && ev.marketplace === 'ours' ? 'connected' : 'drifted';
  const manual: Leftover[] = state !== 'disconnected-externally' ? [] : [...(copy && exists(copy) ? ['plugin-copy' as const] : []), ...(ev.marketplace === 'ours' ? ['marketplace' as const] : [])];
  return { state, manual };
}

export function reconcile(o: {
  dataDir: string; denied: string[] | null; profiles: readonly Profile[];
  /** XAIBO-PROD-599: the profile too, for the real-profile policy (connect.ts boundsFor). */
  target: (p: Profile) => Target | null; permitted: (t: Target, p: Profile) => boolean;
  /** Part 2 review C1: the caller holds the operation lock itself (cleanup's recheck), so its state is not checked. */
  held?: boolean;
}): ReconcileReport {
  if (!o.denied) return { status: 'blocked', code: 'bounds-unavailable' };
  const lock = o.held ? 'free' : lockState(o.dataDir); // read-only: lstat and the holder's pid (review R8)
  if (lock !== 'free') return { status: 'blocked', code: lock };
  let list: ManifestEntry[];
  try { list = readManifest(o.dataDir); } catch { return { status: 'blocked', code: 'manifest' }; }
  const targets = o.profiles.map((p) => [p, o.target(p)] as const);
  return { status: 'ready', entries: list.map((e): Reconciled => {
    const hit = targets.find(([, t]) => t?.file === e.target && t.routes.includes(e.route));
    const r: Reconciled = { entry: e.id, route: e.route, profileId: hit?.[0].id ?? null, state: 'unreadable', cleanup: [], manual: [] };
    if (!hit?.[1]) return { ...r, reason: 'profile-unavailable' };
    if (e.state === 'pending') return { ...r, state: 'pending-recovery' };
    if (!o.permitted(hit[1], hit[0])) return { ...r, reason: 'refused' }; // a root outside the write policy is never read
    if (e.partial) return { ...r, state: 'drifted' };
    // code review (run 197) 2: a legacy plugin entry names no plugin folder to compare (as removePlugin, never inferred)
    if (e.route === 'claude-plugin' && !(e.profileKey && isProfileKey(e.profileKey))) return { ...r, reason: 'legacy' };
    try { // manifest-named paths only from validated names (a profile key, a backup UUID name)
      const copy = e.profileKey && isProfileKey(e.profileKey) ? path.join(o.dataDir, 'integrations', 'claude-plugin', e.profileKey) : null;
      const { state, manual } = e.route === 'claude-plugin' ? plugin(hit[1], copy) : { state: values(e), manual: [] };
      const backup = e.backup && BACKUP_NAME.test(e.backup) && exists(path.join(o.dataDir, 'integrations', 'backups', e.backup)) ? ['backup' as const] : [];
      return { ...r, state, cleanup: state === 'disconnected-externally' ? ['manifest-entry', ...backup] : [], manual };
    } catch (err) { return { ...r, reason: err instanceof ConfigError ? err.code : 'unreadable' }; }
  }) };
}
