// Bundled agent catalog (P1-T08, OQ-X6): integrations/agents.catalog.json validated against its schema with ajv
// (Gate 0 validator, draft 2020-12, strict). Detection subset plus session kinds (P2-T04); unknown fields are rejected.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ruleProblem, SOURCE_AGENT, type MethodRule } from '../usage/sign-in.ts';

export interface AgentEntry {
  id: string;
  displayName: string;
  detection: { binaries: { id: string; names: string[]; versionArgs: string[] }[]; locations?: string[] };
  profileRoots: { id: string; base: 'home'; relative: string; envOverride?: { name: string; mode: 'replaces-base' | 'replaces-root' } }[];
  existenceEvidence?: { root: string; path: string; kind: 'file' | 'directory' }[];
  /** P2-T12 (EC-53): hook events verified for an inclusive x.y.z range. */
  hookEvents?: { versions: { min: string; max?: string }; events: string[]; evidence: string }[];
  /** P6-T03 part 2b (D-P6-07): Claude Connect routes qualified for an inclusive x.y.z range (no max = no upper bound). */
  connectRoutes?: { route: 'claude-plugin' | 'claude-settings-fallback'; versions: { min: string; max?: string }; evidence: string }[];
  /** P3-T13a (§6.8): hook events to status evidence by exact name and field predicates. */
  hookMappings?: HookMappings;
  /** P6-T01a (S-38, FR-54): sign-in method rules; bundled only, none shipped (S14 Pass-narrowed, D-P6-15). */
  signInRules?: MethodRule[];
}
export interface HookRule {
  event: string;
  /** Dotted payload path -> exact value; null = absent or null. */
  where?: Record<string, string | number | boolean | null>;
  map: 'session.start' | 'session.end' | 'turn.start' | 'turn.end' | 'busy' | 'activity' | 'tool.start' | 'tool.end';
  id?: string; tool?: string; args?: string; result?: string;
}
export interface HookMappings { evidence: string; model?: string; rules: HookRule[] }
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
  const issues = catalogIssues(value);
  if (issues.length) throw new Error(`invalid agent catalog: ${issues.map((i) => `${i.at} ${i.code}`).join('; ')}`);
  return value as Catalog;
}

// XAIBO-PROD-565 (P6-T07 part 1; EC-78, SEC5; design .handoff/p6-t07-design.md, review R2/R11): structured issues, fixed
// codes and JSON pointers only (never a submitted value or a parser message). Schema failures first (the semantic checks
// need a well-formed catalog); then checks shared by bundled and imported data; with `bundled`, shadowing of a bundled id,
// binary name or profile root. ponytail: part 2 adds the store codes (too-large, invalid-json, store-corrupt, not-approved).
export type CatalogCode = 'schema-invalid' | 'duplicate-id' | 'unknown-reference' | 'unsafe-value' | 'shadow';
export interface CatalogIssue { code: CatalogCode; at: string }

const older = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
};
const binaryName = (n: string) => n.toLowerCase().replace(/\.exe$/, '');
// code review 1: compared case-folded, since the default macOS and Windows volumes are case-insensitive (.CLAUDE is .claude)
const rootKey = (relative: string) => path.posix.normalize(relative).toLowerCase();
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export function catalogIssues(value: unknown, bundled?: Catalog): CatalogIssue[] {
  // P6-T01a review M1: a pointer below a rule's record would carry a submitted key, so it stops at /record.
  const pointer = (p: string) => (p || '/').replace(/(\/signInRules\/\d+\/record)\/.*$/, '$1');
  if (!check(value)) return [...new Set((check.errors ?? []).map((e) => pointer(e.instancePath)))].map((at) => ({ code: 'schema-invalid' as const, at }));
  const c = value as Catalog, out: CatalogIssue[] = [];
  const add = (code: CatalogCode, at: string) => out.push({ code, at });
  const dup = (ids: string[], at: (j: number) => string) => ids.forEach((id, j) => { if (ids.indexOf(id) < j) add('duplicate-id', at(j)); });
  dup(c.agents.map((a) => a.id), (j) => `/agents/${j}/id`);
  const names = new Set(bundled?.agents.flatMap((b) => b.detection.binaries.flatMap((x) => x.names.map(binaryName))) ?? []);
  const roots = bundled?.agents.flatMap((b) => b.profileRoots.map((r) => rootKey(r.relative))) ?? [];
  c.agents.forEach((a, i) => {
    const p = `/agents/${i}`;
    dup(a.detection.binaries.map((b) => b.id), (j) => `${p}/detection/binaries/${j}/id`);
    dup(a.profileRoots.map((r) => r.id), (j) => `${p}/profileRoots/${j}/id`);
    const declared = new Set(a.profileRoots.map((r) => r.id));
    a.existenceEvidence?.forEach((e, j) => { if (!declared.has(e.root)) add('unknown-reference', `${p}/existenceEvidence/${j}/root`); });
    for (const key of ['hookEvents', 'connectRoutes'] as const) {
      a[key]?.forEach((x, j) => { if (x.versions.max !== undefined && older(x.versions.max, x.versions.min)) add('unsafe-value', `${p}/${key}/${j}/versions`); });
    }
    if (a.connectRoutes && a.id !== 'claude') add('unsafe-value', `${p}/connectRoutes`); // Claude's routes belong to Claude only
    // P6-T01a (review H2): sign-in rules are bundled data only; an imported entry may carry none. Bundled: unique ids, the
    // agent's own surface, and only the allowlisted fields and discriminators (sign-in.ts).
    if (a.signInRules?.length && bundled) add('unsafe-value', `${p}/signInRules`);
    else if (a.signInRules) {
      dup(a.signInRules.map((r) => r.id), (j) => `${p}/signInRules/${j}/id`);
      a.signInRules.forEach((r, j) => {
        const problem = SOURCE_AGENT[r.source] !== a.id ? 'source' : ruleProblem(r);
        if (problem) add('unsafe-value', `${p}/signInRules/${j}/${problem}`);
      });
    }
    if (!bundled) return;
    if (bundled.agents.some((b) => b.id === a.id.toLowerCase())) add('shadow', `${p}/id`);
    a.detection.binaries.forEach((b, k) => b.names.forEach((n, j) => { if (names.has(binaryName(n))) add('shadow', `${p}/detection/binaries/${k}/names/${j}`); }));
    a.profileRoots.forEach((r, j) => { if (roots.some((x) => overlaps(rootKey(r.relative), x))) add('shadow', `${p}/profileRoots/${j}/relative`); });
  });
  const agents = new Set(c.agents.map((a) => a.id));
  c.sessionKinds.forEach((k, j) => { if (!agents.has(k.agent)) add('unknown-reference', `/sessionKinds/${j}/agent`); });
  dup(c.sessionKinds.map((k) => `${k.agent}\0${k.id}`), (j) => `/sessionKinds/${j}/id`);
  return out;
}
