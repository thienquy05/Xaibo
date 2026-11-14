// Codex hooks route (P3-T06; FR-31, FR-34, FR-06, EC-25, S5). One group per 0.160.0 event is appended to
// $CODEX_HOME/hooks.json through the FR-32 engine (route codex-hooks), after every existing group so a later removal
// never shifts a foreign hook onto another hook's trust key (S5-C5; the engine reports a Xaibo group with anything
// after it as a conflict instead of removing it). Each runs the stable shim as `'<shim>' hook codex <profile_key>`,
// async only where S5 saw it accepted. Codex runs the hooks only after the owner approves them in Codex's own review:
// Xaibo never writes config.toml or trust state and never skips the review, so after install the state is "installed,
// awaiting trust" with guided steps, and "connected" only once a hook delivery for this profile arrives after the
// install, or after the last change to Xaibo's groups (Codex re-reviews a changed declaration, S5-C4). Rollout ingest
// is independent of all this. Bounds come from the caller (dev CLI: disposable profiles only, real roots denied).
import { createHash } from 'node:crypto';
import { lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  apply, ConfigError, plan, readFile, readManifest, recordEntry, resolveTarget, revert, type Bounds, type ManifestEntry, type Op, type Plan, type RevertResult,
} from '../../config/transaction.ts';
import { CODEX_ASYNC_EVENTS, CODEX_HOOK_EVENTS } from './hooks.ts';

export interface CodexHookOptions {
  dataDir: string; profileKey: string;
  /** The profile's CODEX_HOME, inside `bounds`. */
  codexHome: string;
  bounds: Bounds;
}
export interface CodexHookStatus {
  state: 'not-installed' | 'awaiting-trust' | 'connected';
  label: 'not installed' | 'installed, awaiting trust' | 'connected';
  reason?: 'no-event' | 'entry-changed';
  /** Guided trust steps while awaiting trust (FR-31), else empty. */
  steps: string[];
}

const PROFILE_KEY = /^[A-Za-z0-9._-]{1,128}$/; // as the hook protocol's profile_key
const fail = (code: ConfigError['code']): never => { throw new ConfigError(code); };
const key = (k: string) => (PROFILE_KEY.test(k) && k !== '.' && k !== '..' ? k : fail('ops'));
const uid = process.getuid?.();
export const shimPath = (dataDir: string) => path.join(dataDir, 'integrations', 'bin', 'xaibo-hook');
const target = (o: CodexHookOptions) => resolveTarget(path.join(o.codexHome, 'hooks.json'), o.bounds);
const recorded = (o: CodexHookOptions, file: string) => readManifest(o.dataDir).find((e) => e.target === file && e.route === 'codex-hooks');

export function codexHookOps(shim: string, profileKey: string): Op[] {
  if (shim.includes("'")) throw new Error('codex hooks: the shim path must not contain a single quote');
  const command = `'${shim}' hook codex ${key(profileKey)}`;
  return CODEX_HOOK_EVENTS.map((ev) => ({
    op: 'append', pointer: `/hooks/${ev}`,
    value: { hooks: [{ type: 'command', command, ...(CODEX_ASYNC_EVENTS.includes(ev) ? { async: true } : {}) }] },
  }));
}

/** `preview`: the exact plan the owner confirmed, so an edit since then aborts with `changed` (G3a-2, EC-48). */
export function installCodexHooks(o: CodexHookOptions, preview?: Plan): ManifestEntry {
  const file = target(o);
  if (recorded(o, file)) fail('duplicate');
  const shim = shimPath(o.dataDir);
  let st;
  try { st = lstatSync(shim); } catch { return fail('shim-missing'); }
  if (!st.isFile() || (uid !== undefined && st.uid !== uid)) fail('shim-missing');
  return apply(preview ?? plan(file, 'codex-hooks', codexHookOps(shim, o.profileKey), o.bounds), { dataDir: o.dataDir, bounds: o.bounds });
}

export function uninstallCodexHooks(o: CodexHookOptions): RevertResult {
  const entry = recorded(o, target(o));
  if (!entry) return fail('not-installed');
  return revert(entry, { dataDir: o.dataDir, bounds: o.bounds });
}

export function codexTrustSteps(codexHome: string, shim: string, profileKey: string): string[] {
  return [
    `Open Codex once in a terminal for this profile (CODEX_HOME=${codexHome}) and start a session.`,
    `Codex asks you to review ${CODEX_HOOK_EVENTS.length} new hooks added by Xaibo, each running: '${shim}' hook codex ${profileKey}. Approve them in that review (accepting Codex's folder-trust prompt also trusts them).`,
    'Send any prompt. Xaibo shows Connected when the first hook event arrives.',
    "Until then Xaibo keeps reading Codex's session files; live status from hooks is unavailable. Xaibo never approves hooks for you and never skips Codex's review.",
  ];
}

const fingerprint = (values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
/** What now stands at Xaibo's recorded positions (a shifted group changes it too); null when unreadable. Read bounded,
 *  never through a symlink or from a FIFO: the coverage poll runs this every 5 s (P3-T10 security review M2). */
function declared(file: string, entry: ManifestEntry): string | null {
  try {
    const f = readFile(file);
    if (!f) return null;
    const doc: unknown = JSON.parse(f.bytes.toString('utf8'));
    return fingerprint(entry.owned.map((x) => x.pointer.slice(1).split('/')
      .reduce<unknown>((n, k) => (n !== null && typeof n === 'object' && Object.hasOwn(n, k) ? (n as Record<string, unknown>)[k] : undefined), doc) ?? null));
  } catch {
    return null;
  }
}

/** FR-06/EC-25: connected only on a delivery received after the install and after every observed change to Xaibo's
 *  declarations (an unreadable or missing file included); each change seen is remembered in the manifest entry with a
 *  boundary past every delivery stored by then, so restoring an earlier declaration, even with an old mtime, still
 *  needs a new delivery. ponytail: changes are observed when status runs; an edit undone between two calls goes unseen (Codex
 *  trust then still matches, unless the owner approved the edit in between, which a new delivery would also show). */
export function codexHookStatus(o: CodexHookOptions & { db: DatabaseSync }): CodexHookStatus {
  const file = target(o);
  const entry = recorded(o, file);
  if (!entry || entry.state !== 'applied') return { state: 'not-installed', label: 'not installed', steps: [] };
  const before = entry.seen ?? { hash: fingerprint(entry.owned.map((x) => x.value)), since: Date.parse(entry.at) };
  let seen = before;
  const now = declared(file, entry) ?? 'unreadable';
  const last = (o.db.prepare("SELECT max(received_ts) AS t FROM hook_delivery WHERE agent = 'codex' AND profile_key = ?")
    .get(o.profileKey) as { t: number | null }).t;
  if (now !== seen.hash) {
    // past every delivery already stored (an old mtime cannot revive them) and past the change itself when known
    let at = 0;
    try { at = statSync(file).mtimeMs; } catch { /* gone: the stored deliveries bound it */ }
    seen = { hash: now, since: Math.max(seen.since, at, (last ?? -1) + 1) };
    recordEntry(o.dataDir, { ...entry, seen });
  }
  const reason: CodexHookStatus['reason'] = entry.seen || seen !== before ? 'entry-changed' : 'no-event';
  if (now !== 'unreadable' && last !== null && last >= seen.since) return { state: 'connected', label: 'connected', steps: [] };
  return { state: 'awaiting-trust', label: 'installed, awaiting trust', reason, steps: codexTrustSteps(o.codexHome, shimPath(o.dataDir), o.profileKey) };
}
