// Capability detection by agent version (P2-T12, EC-53): the hook events of the catalog range holding the version, or
// null when the version is unknown, unparsable or outside every verified range (never an assumed set). Pure; nothing
// in Xaibo depends on PreModelRequest/PostModelRequest, this only reports them.
import type { Catalog } from './validate.ts';

export interface Capabilities { hookEvents: string[]; modelRequestHooks: boolean }

const parts = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
const cmp = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

export function capabilities(catalog: Catalog, agent: string, version: string | null): Capabilities | null {
  const v = version ? parts(version) : undefined;
  if (!v) return null;
  const range = catalog.agents.find((a) => a.id === agent)?.hookEvents
    ?.find((r) => cmp(v, parts(r.versions.min)!) >= 0 && (!r.versions.max || cmp(v, parts(r.versions.max)!) <= 0));
  if (!range) return null;
  return { hookEvents: [...range.events], modelRequestHooks: range.events.includes('PreModelRequest') && range.events.includes('PostModelRequest') };
}
