// XAIBO-PROD-556 (P6-T02; EC-73, EC-90, FR-33, D-9, D-19): the Connect plan's retention offers, as pure builders over the
// FR-32 engine. Claude: a default-selected, deselectable raise of cleanupPeriodDays to max(effective, 45) on the
// claude-retention route (plan() guards it: only that value, never over a higher or unreadable one); managed policy wins
// and is shown; one retention entry per settings.json. Disconnect is the engine's revert (the prior value back or the key
// removed only while Xaibo's value is unchanged, else a conflict). Gemini: no offer until S11 runtime-verifies retention.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { RETENTION_DAYS, type ManifestEntry, type Op } from '../config/transaction.ts';
import { claudeCleanup } from '../history/native-availability.ts';
import { inRange } from './capabilities.ts';
import type { Detection } from './detect.ts';
import type { Catalog } from './validate.ts';

export { RETENTION_DAYS };
export type RetentionOffer =
  | { offered: true; from: number; to: number; layer: 'user' | 'default'; ops: Op[] }
  /** policy: managed policy sets it (days null = not readable); enough: 45 or more; unknown: a file or value Xaibo cannot
   *  read; connected: Xaibo's retention entry is already recorded; unverified: the agent's retention is not verified. */
  | { offered: false; reason: 'policy' | 'enough' | 'unknown' | 'connected' | 'unverified'; days: number | null };

/** `managedDir` is required so a caller never reads this machine's managed policy by default (design review M3); the
 *  service passes CLAUDE_MANAGED_DIR. `entries` is the FR-32 manifest. */
export function claudeRetentionOffer(configDir: string, managedDir: string, entries: ManifestEntry[]): RetentionOffer {
  const c = claudeCleanup(configDir, managedDir);
  if (!c) return { offered: false, reason: 'unknown', days: null };
  if (c.layer === 'managed') return { offered: false, reason: 'policy', days: c.days };
  if (c.days === null) return { offered: false, reason: 'unknown', days: null };
  let file: string | null = null;
  // realpath native, as resolveTarget (code review LOW-1: a profile path in other letter case on a case-insensitive volume)
  try { file = path.join(realpathSync.native(configDir), 'settings.json'); } catch { /* no profile folder: nothing recorded for it */ }
  if (entries.some((e) => e.route === 'claude-retention' && e.target === file)) return { offered: false, reason: 'connected', days: c.days };
  if (c.days >= RETENTION_DAYS) return { offered: false, reason: 'enough', days: c.days };
  return { offered: true, from: c.days, to: RETENTION_DAYS, layer: c.layer, ops: [{ op: 'set', pointer: '/cleanupPeriodDays', value: RETENTION_DAYS }] };
}

/** Default-selected: the offer's ops unless the owner deselects it; nothing when not offered. */
export const retentionOps = (offer: RetentionOffer, selected = true): Op[] => (offer.offered && selected ? offer.ops : []);

/** XAIBO-PROD-560 (P6-T03 part 2b; D-2, owner D-P6-07): Claude's Connect route from the catalog and the detected version: the
 *  plugin where a range qualifies it, else the settings fallback where one qualifies that; null (unverified) for an undetected
 *  Claude, no or a prerelease version, or a version in no range. No chooser, no override; never a fallback after a failure. */
export function claudeConnectRoute(catalog: Catalog, d: Detection | undefined): 'claude-plugin' | 'claude-settings-fallback' | null {
  if (d?.state !== 'detected') return null;
  // part 2c review H1: a manually chosen executable never gets the plugin route, which runs it; the fallback runs nothing
  const ok = (catalog.agents.find((a) => a.id === 'claude')?.connectRoutes ?? [])
    .filter((r) => inRange(d.version, r.versions) && !(d.manual && r.route === 'claude-plugin')).map((r) => r.route);
  return ok.includes('claude-plugin') ? 'claude-plugin' : ok.includes('claude-settings-fallback') ? 'claude-settings-fallback' : null;
}

/** EC-90, D-19: Gemini's maxAge raise stays off until S11 runtime-verifies retention; reads nothing. */
export const geminiRetentionOffer = (): RetentionOffer => ({ offered: false, reason: 'unverified', days: null });
