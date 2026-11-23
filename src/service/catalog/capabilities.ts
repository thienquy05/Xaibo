// Capability detection by agent version (P2-T12, EC-53): the hook events of the catalog range holding the version, or
// null when the version is unknown, unparsable or outside every verified range (never an assumed set). Pure; nothing
// in Xaibo depends on PreModelRequest/PostModelRequest, this only reports them.
import type { Catalog } from './validate.ts';

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
