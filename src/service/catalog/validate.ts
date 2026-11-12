// Bundled agent catalog (P1-T08, OQ-X6): integrations/agents.catalog.json validated against its schema with ajv
// (Gate 0 validator, draft 2020-12, strict). Detection subset plus session kinds (P2-T04); unknown fields are rejected.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';

export interface AgentEntry {
  id: string;
  displayName: string;
  detection: { binaries: { id: string; names: string[]; versionArgs: string[] }[]; locations?: string[] };
  profileRoots: { id: string; base: 'home'; relative: string; envOverride?: { name: string; mode: 'replaces-base' | 'replaces-root' } }[];
  existenceEvidence?: { root: string; path: string; kind: 'file' | 'directory' }[];
  /** P2-T12 (EC-53): hook events verified for an inclusive x.y.z range. */
  hookEvents?: { versions: { min: string; max?: string }; events: string[]; evidence: string }[];
}
/** P2-T04: entry point → badge, interactive flag, resume args (`{id}` placeholder) or a disabled reason. */
export interface SessionKind {
  agent: string; id: string; match: { entrypoint?: string; originator?: string };
  badge?: string; interactive?: boolean; evidence: string;
  resume?: { args: string[]; promptRequired?: boolean }; resumeDisabled?: string;
}
export interface Catalog { schemaVersion: 1; agents: AgentEntry[]; sessionKinds: SessionKind[] }

const DIR = new URL('../../../integrations/', import.meta.url); // same depth under src/ and out/
const check = new Ajv2020({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(new URL('agents.catalog.schema.json', DIR), 'utf8')) as object);

/** Schema errors as short text (empty = valid). */
export function validateCatalog(value: unknown): string[] {
  return check(value) ? [] : (check.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

export function loadCatalog(url: URL = new URL('agents.catalog.json', DIR)): Catalog {
  const value: unknown = JSON.parse(readFileSync(url, 'utf8'));
  const errors = validateCatalog(value);
  if (errors.length) throw new Error(`invalid agent catalog: ${errors.join('; ')}`);
  return value as Catalog;
}
