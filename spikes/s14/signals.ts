// P6-S14-T1 (S14, FR-54): pure sign-in-method classifier over the production projection of already-ingested agent
// output. A rule names one exact agent version, one source, a record discriminator, one field path and one bounded
// predicate; nothing else is evidence. No file, environment, process or network access (signals.test.ts traces it).
// The shape is the draft for the P6-T01a catalog contract; synthetic rules here certify no live mapping.
import { captureRecord } from '../../src/forwarder/statusline-tee.ts';
import { parseLine } from '../../src/service/adapters/codex/parse.ts';
import { codexRateLimits } from '../../src/service/usage/tokens.ts';

export const METHODS = ['subscription', 'api-key', 'cloud-provider', 'gateway', 'mixed'] as const;
export const SOURCES = ['claude-statusline', 'claude-transcript', 'codex-rollout', 'agy-transcript'] as const;
export type Method = (typeof METHODS)[number];
export type Source = (typeof SOURCES)[number];
export interface Rule {
  id: string; source: Source; version: string;
  record: Record<string, string>; // record discriminator: field path -> exact literal
  field: string;
  test: { oneOf: string[] } | { nonEmptyObject: true };
  method: Method;
}
export interface Observation { source: Source; version: string; raw: string }
export type Result = { method: Method; rules: string[] } | { method: 'unknown'; reason: 'no-signal' | 'conflict' | 'unsupported-version' };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const ID = /^[a-z]+(-[a-z]+)*$/;
export const VERSION = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/;
export const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/;
const LITERAL = /^[A-Za-z0-9_-]{1,64}$/;
const ENUM = /^[A-Za-z0-9_-]{1,32}$/;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
// Never method evidence (design: model, tokens/usage, cost, credits, account ids, context, effort).
const EXCLUDED = /^(model|cost|credits|usage|info|context_window|session_id|effort)$|token|account|user_id/i;

export const agentOf = (s: Source) => s.slice(0, s.indexOf('-'));
const okField = (f: unknown): f is string => typeof f === 'string' && FIELD.test(f) && !f.split('.').some((s) => UNSAFE.has(s));

export function ruleIssues(r: Rule): string[] {
  const out: string[] = [];
  if (typeof r.id !== 'string' || !ID.test(r.id)) out.push('bad-id');
  if (typeof r.version !== 'string' || !VERSION.test(r.version)) out.push('bad-version');
  if (!SOURCES.includes(r.source)) out.push('bad-source');
  if (!okField(r.field)) out.push('bad-field');
  else if (r.field.split('.').some((s) => EXCLUDED.test(s))) out.push('excluded-field');
  if (!isObj(r.record) || Object.entries(r.record).some(([k, v]) => !okField(k) || typeof v !== 'string' || !LITERAL.test(v))) out.push('bad-record');
  else if (Object.keys(r.record).some((k) => k.split('.').some((s) => EXCLUDED.test(s))) && !out.includes('excluded-field')) out.push('excluded-field'); // review 4
  const t = r.test as Obj;
  const keys = isObj(t) ? Object.keys(t) : [];
  const oneOf = keys.length === 1 && Array.isArray(t.oneOf) && t.oneOf.length >= 1 && t.oneOf.length <= 16 && t.oneOf.every((v) => typeof v === 'string' && ENUM.test(v));
  if (!oneOf && !(keys.length === 1 && t.nonEmptyObject === true)) out.push('bad-test');
  if (!METHODS.includes(r.method)) out.push('bad-method');
  return out;
}

const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (isObj(v) && Object.hasOwn(v, k) ? v[k] : undefined), o);
const prune = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/** What production keeps of one record, in the record's own path shape; undefined when production keeps nothing. */
export function project(source: Source, raw: string): Obj | undefined {
  if (source === 'codex-rollout') {
    const r = parseLine(Buffer.from(raw), { offset: 0, fileIdentity: 'synthetic', fileMtime: 0, receivedTs: 0 });
    if (!r?.ok) return undefined;
    const rec = r.record;
    if (!rec.rateLimits) return { type: rec.type, payload: prune({ type: rec.payloadType }) };
    const rl = codexRateLimits(rec.rateLimits);
    const windows = Object.fromEntries(rl.windows.map((w) => [w.kind, prune({ window_minutes: w.durationMinutes, used_percent: w.usedPercent, resets_at: w.resetsAt })]));
    return { type: rec.type, payload: prune({ type: rec.payloadType, rate_limits: prune({ plan_type: rl.plan, limit_id: rl.limitId, ...windows }) }) };
  }
  if (source !== 'claude-statusline') return undefined; // transcripts: no projection until P6-T01a wires their parsers (review 5)
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return undefined; }
  return isObj(v) ? captureRecord(v) : undefined;
}

function matches(r: Rule, p: Obj): boolean {
  if (!Object.entries(r.record).every(([k, lit]) => get(p, k) === lit)) return false;
  const v = get(p, r.field);
  if ('oneOf' in r.test) return typeof v === 'string' && r.test.oneOf.includes(v);
  return isObj(v) && Object.keys(v).length > 0;
}

/** One profile's observations -> one method, or Unknown with a reason. Disagreeing rules are a conflict, never Mixed;
 *  Mixed comes only from an explicit mixed rule. An agent version with no valid rule is unsupported. */
export function classify(obs: Observation[], rules: Rule[]): Result {
  const valid = rules.filter((r) => ruleIssues(r).length === 0);
  const hits = new Map<string, Method>();
  let catalogued = obs.length === 0;
  for (const o of obs) {
    if (!SOURCES.includes(o.source)) continue;
    if (valid.some((r) => agentOf(r.source) === agentOf(o.source) && r.version === o.version)) catalogued = true;
    const own = valid.filter((r) => r.source === o.source && r.version === o.version);
    const p = own.length ? project(o.source, o.raw) : undefined;
    if (p) for (const r of own) if (matches(r, p)) hits.set(r.id, r.method);
  }
  const methods = new Set(hits.values());
  if (methods.size === 1) return { method: [...methods][0]!, rules: [...hits.keys()].sort() };
  if (methods.size > 1) return { method: 'unknown', reason: 'conflict' };
  return { method: 'unknown', reason: catalogued ? 'no-signal' : 'unsupported-version' };
}
