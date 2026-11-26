// Capability detection by agent version (P2-T12, EC-53): the hook events of the catalog range holding the version, or
// null when the version is unknown, unparsable or outside every verified range (never an assumed set). Pure; nothing
// in Xaibo depends on PreModelRequest/PostModelRequest, this only reports them.
import type { Catalog, CompatibilityRow } from './validate.ts';

export interface Capabilities { hookEvents: string[]; modelRequestHooks: boolean }

const parts = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
const cmp = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
const within = (v: number[], r: { min: string; max?: string }) => cmp(v, parts(r.min)!) >= 0 && (!r.max || cmp(v, parts(r.max)!) <= 0);
/** P6-T03 part 2b (review H1): an exact release x.y.z inside the inclusive range; a prerelease or anything else is outside. */
export const inRange = (version: string | null, r: { min: string; max?: string }) =>
  !!version && /^\d+\.\d+\.\d+$/.test(version) && within(parts(version)!, r);

// ponytail (P6-T03 code review L5): this reads a prerelease's x.y.z prefix as that release (older behaviour; no service code
// calls it yet); Connect routes use inRange, which refuses prereleases. Route this through inRange before anything gates on it.
export function capabilities(catalog: Catalog, agent: string, version: string | null): Capabilities | null {
  const v = version ? parts(version) : undefined;
  if (!v) return null;
  const range = catalog.agents.find((a) => a.id === agent)?.hookEvents?.find((r) => within(v, r.versions));
  if (!range) return null;
  return { hookEvents: [...range.events], modelRequestHooks: range.events.includes('PreModelRequest') && range.events.includes('PostModelRequest') };
}

// XAIBO-PROD-591 (P6-T08 slice B; EC-79, US-8; D-P6-19): compatibility labels from the bundled catalog rows (Gate 0 S6/S7). A
// surface's facts are stated only for an exact tested release; an unknown, prerelease or untested version, or a surface with no
// row (VS Code, Desktop: untested), is unverified with its reason. Never "supported"; display only, never a permission.
// ponytail (slice B code review L3): rows are read from the merged catalog; imported rows are refused at import and at every
// load (catalogIssues with the bundled catalog), the single control; pass the bundled catalog here if that ever changes.
const SURFACE: Record<CompatibilityRow['surface'], string> = {
  cli: 'CLI', exec: 'Codex non-interactive (exec)', 'app-server': 'App-server client', 'sdk-cli': 'Claude print mode (-p)', bg: 'Background (--bg)', vscode: 'VS Code extension', desktop: 'Desktop app',
};
export function compatibility(catalog: Catalog | null, agent: string, version: string | null): string[] {
  const rows = catalog?.agents.find((a) => a.id === agent)?.compatibility ?? [];
  if (!rows.length) return [];
  const release = version && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  const surfaces = [...new Set([...rows.map((r) => r.surface), 'vscode' as const, 'desktop' as const])];
  return surfaces.map((s) => {
    const r = release ? rows.find((x) => x.surface === s && x.version === release) : undefined;
    if (!r) {
      const tested = [...new Set(rows.filter((x) => x.surface === s).map((x) => x.version))];
      return `${SURFACE[s]}: unverified for ${version ?? 'an unknown version'} (${tested.length ? `tested on ${tested.join(', ')}` : 'not tested'})`;
    }
    return `${SURFACE[s]}: history visibility ${r.visible}, resume ${r.resumable}, live attach ${r.attach}, ownership ${r.ownership} for ${release}${r.note ? ` (${r.note})` : ''}`;
  }).map((l) => (l.length > 256 ? `${l.slice(0, 255)}…` : l)); // code review L4: one long line never fails the whole detail reply (IPC bound 256)
}
