// XAIBO-PROD-570 (P6-T01a slice 1; S-38, FR-54; design .handoff/p6-t01a-design.md, security review 3627): sign-in
// method rules as catalog data and their pure evaluator. Eligible inputs are a fixed per-source allowlist of string leaves
// of the production projection (review H1): nothing else, so model, tokens, cost, credits, account ids, quota windows and
// limit ids can never select a method. S14 Pass-narrowed (D-P6-15): the bundled catalog ships no rules, so every profile
// stays Unknown unless the owner declares a method. Pure: no file, environment, process or network access.
export const KNOWN_METHODS = ['subscription', 'api-key', 'cloud-provider', 'gateway', 'mixed'] as const;
export const SIGNAL_SOURCES = ['claude-statusline', 'claude-transcript', 'codex-rollout', 'agy-transcript'] as const;
export type KnownMethod = (typeof KNOWN_METHODS)[number];
export type Method = KnownMethod | 'unknown';
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export interface MethodRule {
  id: string; source: SignalSource; version: string;
  /** Record discriminator: exactly the source's allowlisted paths -> exact literals. */
  record: Record<string, string>;
  field: string;
  test: { oneOf: string[] };
  method: KnownMethod;
}
export interface MethodObservation { source: SignalSource; version: string | null; projected: Readonly<Record<string, unknown>> }
export type MethodResult =
  | { kind: 'matched'; method: KnownMethod; ruleId: string }
  | { kind: 'unknown'; reason: 'no-signal' | 'unsupported-version' | 'unsupported-surface' | 'ambiguous' };

/** The agent each native surface belongs to (no catalog entry may claim another agent's surface). */
export const SOURCE_AGENT: Record<SignalSource, string> = {
  'claude-statusline': 'claude', 'claude-transcript': 'claude', 'codex-rollout': 'codex', 'agy-transcript': 'agy',
};
// Codex rollout: the token_count projection (parseLine + codexRateLimits). ponytail: Claude statusLine has no eligible
// string leaf and no version in its projection, transcripts no projection; add them with a reviewed projection and a
// verified rule (S14 R3).
const ELIGIBLE: Partial<Record<SignalSource, { fields: readonly string[]; discriminators: readonly string[] }>> = {
  'codex-rollout': { fields: ['payload.rate_limits.plan_type'], discriminators: ['type', 'payload.type'] },
};

/** Which part of a rule is outside the allowlist ('source': the surface has no eligible field), else null. */
export function ruleProblem(r: MethodRule): 'source' | 'field' | 'record' | null {
  const e = Object.hasOwn(ELIGIBLE, r.source) ? ELIGIBLE[r.source] : undefined;
  if (!e) return 'source';
  if (!e.fields.includes(r.field)) return 'field';
  // code review L2/L3: exactly the source's discriminators (never any record type); a malformed record is refused, not thrown
  if (typeof r.record !== 'object' || r.record === null || Array.isArray(r.record)) return 'record';
  const keys = Object.keys(r.record);
  return keys.length === e.discriminators.length && e.discriminators.every((k) => keys.includes(k)) ? null : 'record';
}

const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>(
  (v, k) => (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined), o);

function matches(r: MethodRule, p: Readonly<Record<string, unknown>>): boolean {
  if (!Object.keys(r.record).every((k) => get(p, k) === r.record[k])) return false;
  const v = get(p, r.field);
  return typeof v === 'string' && Array.isArray(r.test.oneOf) && r.test.oneOf.includes(v);
}

/** One observation -> the method its rules give, or Unknown with a fixed reason. Exact version only; rules of another
 *  source or outside the allowlist are ignored even if a caller passes them (review L4). Disagreeing rules are ambiguous,
 *  never Mixed; agreeing rules report the smallest rule id. */
export function evaluateMethod(o: MethodObservation, rules: readonly MethodRule[]): MethodResult {
  if (!Object.hasOwn(ELIGIBLE, o.source)) return { kind: 'unknown', reason: 'unsupported-surface' };
  const own = typeof o.version === 'string' ? rules.filter((r) => r.source === o.source && r.version === o.version && ruleProblem(r) === null) : [];
  if (!own.length) return { kind: 'unknown', reason: 'unsupported-version' };
  const hits = own.filter((r) => matches(r, o.projected));
  const methods = new Set(hits.map((r) => r.method));
  if (methods.size > 1) return { kind: 'unknown', reason: 'ambiguous' };
  if (!hits.length) return { kind: 'unknown', reason: 'no-signal' };
  return { kind: 'matched', method: hits[0]!.method, ruleId: hits.map((r) => r.id).sort()[0]! };
}
