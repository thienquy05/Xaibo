// agy hooks route (P3-T13d; plan P3-T13, D-P3-12). Xaibo installs agy hooks only into <profile HOME>/.gemini/config/
// hooks.json, through the FR-32 engine (route agy-hooks), as one top-level group `xaibo` in the config shape P2-T00
// recorded firing all six events (test/fixtures/synthetic/config/agy-hooks/recorded-shape.json): plain events take
// [{type, command, timeout}], tool events [{matcher: '*', hooks: [{type, command, timeout}]}]. Each runs the stable shim
// as `'<shim>' hook agy <profile_key>`; no async field (unverified for agy, so the verified synchronous form: the
// forwarder exits within its own deadline with empty output), and no retention or other key. Foreign groups are never
// changed and revert is the engine's. P2-T00 also verified the project file .agents/hooks.json: the selected project's
// file is only inspected, never written, and a Xaibo hook found there or already in the profile file refuses the install
// (duplicate), so agy never runs Xaibo twice. Bounds come from the caller (dev CLI: disposable profiles only).
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { apply, ConfigError, plan, readFile, readManifest, resolveTarget, within, type Bounds, type ManifestEntry, type Op, type Plan } from '../../config/transaction.ts';
import { shimPath } from '../codex/setup.ts';

export const AGY_HOOK_EVENTS = ['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
const TOOL_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse']);
const GROUP = 'xaibo';
const TIMEOUT_S = 10; // as recorded

export interface AgyHookOptions {
  dataDir: string; profileKey: string;
  /** The profile's HOME, inside `bounds`. */
  profileHome: string;
  /** The selected disposable project, whose .agents/hooks.json is inspected for a Xaibo hook. */
  project?: string;
  bounds: Bounds;
}

const PROFILE_KEY = /^[A-Za-z0-9._-]{1,128}$/; // as the hook protocol's profile_key
const fail = (code: ConfigError['code']): never => { throw new ConfigError(code); };
const key = (k: string) => (PROFILE_KEY.test(k) && k !== '.' && k !== '..' ? k : fail('ops'));
const uid = process.getuid?.();
export const agyHooksFile = (profileHome: string) => path.join(profileHome, '.gemini', 'config', 'hooks.json');

export function agyHookOps(shim: string, profileKey: string): Op[] {
  if (shim.includes("'")) throw new Error('agy hooks: the shim path must not contain a single quote');
  const hook = { type: 'command', command: `'${shim}' hook agy ${key(profileKey)}`, timeout: TIMEOUT_S };
  const group = Object.fromEntries(AGY_HOOK_EVENTS.map((ev) => [ev, [TOOL_EVENTS.has(ev) ? { matcher: '*', hooks: [hook] } : hook]]));
  return [{ op: 'set', pointer: `/${GROUP}`, value: group }];
}

/** The parsed file (null when absent); anything unreadable or not JSON refuses, since it cannot be checked. */
function parsed(file: string): unknown {
  const cur = readFile(file);
  if (!cur) return null;
  try { return JSON.parse(cur.bytes.toString('utf8')); } catch { return fail('invalid-json'); }
}

// Any Xaibo hook shim for agy, whatever its quoting, prefix or data-dir spelling (review M1).
const XAIBO_AGY = /xaibo-hook['"]?\s+hook\s+agy(\s|$)/;
/** True when any command hook in `doc` runs a Xaibo shim for agy. */
function runsShim(doc: unknown): boolean {
  if (Array.isArray(doc)) return doc.some(runsShim);
  if (typeof doc !== 'object' || doc === null) return false;
  const o = doc as Record<string, unknown>;
  if (o['type'] === 'command' && typeof o['command'] === 'string' && XAIBO_AGY.test(o['command'])) return true;
  return Object.values(o).some(runsShim);
}

/** The project's .agents/hooks.json, read only: the project must exist outside every denied root, .agents is never a link. */
function projectHooks(project: string, bounds: Bounds): unknown {
  let dir: string;
  try { dir = realpathSync.native(project); } catch { return fail('parent-missing'); }
  if (bounds.denied.some((d) => within(dir, d))) fail('denied-root');
  let st;
  try { st = lstatSync(path.join(dir, '.agents')); } catch { return null; } // no .agents: nothing to inspect
  if (st.isSymbolicLink()) fail('symlink');
  if (!st.isDirectory()) fail('not-regular');
  return parsed(path.join(dir, '.agents', 'hooks.json'));
}

/** The duplicate checks (review M2: the dev CLI's plan runs them too); returns the resolved target and the ops. */
export function checkAgyInstall(o: AgyHookOptions): { file: string; ops: Op[] } {
  const file = resolveTarget(agyHooksFile(o.profileHome), o.bounds);
  const ops = agyHookOps(shimPath(o.dataDir), o.profileKey);
  if (readManifest(o.dataDir).some((e) => e.target === file && e.route === 'agy-hooks')) fail('duplicate');
  const doc = parsed(file);
  if (doc && typeof doc === 'object' && Object.hasOwn(doc, GROUP)) fail('duplicate'); // never replace a group by that name
  if (runsShim(doc)) fail('duplicate');
  if (o.project && runsShim(projectHooks(o.project, o.bounds))) fail('duplicate');
  return { file, ops };
}

/** `preview`: the exact plan the owner confirmed, so an edit since then aborts with `changed` (G3a-2, EC-48). */
export function installAgyHooks(o: AgyHookOptions, preview?: Plan): ManifestEntry {
  const { file, ops } = checkAgyInstall(o);
  const shim = shimPath(o.dataDir);
  let st;
  try { st = lstatSync(shim); } catch { return fail('shim-missing'); }
  if (!st.isFile() || (uid !== undefined && st.uid !== uid)) fail('shim-missing');
  const p = preview ?? plan(file, 'agy-hooks', ops, o.bounds);
  if (p.diff.some((d) => d.replaced)) fail('duplicate'); // a `xaibo` group that appeared since the check (review L4)
  return apply(p, { dataDir: o.dataDir, bounds: o.bounds });
}
