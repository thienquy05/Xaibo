// Stuck/loop rules R1–R5 (P3-T09, PRD §6.4, FR-04, US-4; MIT-licensed rules adapted from blazo). R2–R4 follow the
// completed calls of the current turn and are updated as the status engine folds evidence; R1 and R5 depend on the clock
// and are read with the status, counting awake time only (suspended time excluded). A finding is a rule id plus a
// signature, one per (session, rule): it never changes the lifecycle and never terminates anything, and it is cleared
// when progress breaks the pattern or a new turn starts. Signatures are truncated hashes, never content.
import { createHash } from 'node:crypto';

/** Setting keys with the PRD defaults (Q3-14); the Settings screen adjusts them after Gate D. */
export interface RuleSettings {
  /** R1: busy with no evidence for longer than this, and no known wait. */
  noProgressMs: number;
  /** R2: the same tool, normalized args and result this many times in a row within a turn. */
  repeatedTool: number;
  /** R3: the same tool and error this many times in a row. */
  repeatedError: number;
  /** R4: a 2- or 3-call sequence repeated this many times in a row within a turn. */
  cycleRepeats: number;
  /** R5: one call in flight longer than this. */
  longToolMs: number;
}
export const RULE_DEFAULTS: RuleSettings = { noProgressMs: 300_000, repeatedTool: 4, repeatedError: 3, cycleRepeats: 3, longToolMs: 600_000 };

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` normalize alike. */
const stable = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x)) ?? 'null';
// ponytail: the whole payload is normalized and hashed on ingest (linear in its size, like the JSON.parse before it), and
// the hash is unsalted, so a short value can be confirmed by guessing (the store already keeps raw hook payloads). Hash a
// bounded prefix plus length if large tool output shows in ingest timing; add a per-install salt if the store loses raw payloads.
/** A 16-hex signature of normalized values: equal inputs match, and no content is kept. */
export const sig = (...parts: unknown[]) => createHash('sha256').update(stable(parts)).digest('hex').slice(0, 16);
/** `{ sig }` of a field (with an optional prefix such as the tool name), or nothing when the field is absent: an absent
 * field never makes two calls look alike (review). */
export const sigField = (v: unknown, prefix?: unknown): { sig?: string } => (v === undefined || v === null ? {} : { sig: sig(prefix, v) });

export interface Patterns {
  run: { sig: string; n: number } | null;
  errs: { sig: string; n: number } | null;
  recent: string[];
  /** Active R2–R4 findings: rule -> signature. */
  found: Map<string, string>;
}
export const freshPatterns = (): Patterns => ({ run: null, errs: null, recent: [], found: new Map() });

function mark(p: Patterns, rule: string, s: string | null) {
  if (s === null) p.found.delete(rule); else p.found.set(rule, s);
}

/** The trailing 2- or 3-call pattern repeated `reps` times, if any; one call repeated is R2's, not a cycle. */
function cycle(recent: string[], reps: number): string | null {
  for (const k of [2, 3]) {
    const w = recent.slice(-k * reps);
    if (w.length < k * reps) continue;
    const pat = w.slice(0, k);
    if (new Set(pat).size > 1 && w.every((s, i) => s === pat[i % k])) return sig(pat);
  }
  return null;
}

/** One completed call of the current turn. `call` = tool, args and result signature; `err` = tool and error, or null. */
export function onCall(p: Patterns, r: RuleSettings, call: string, err: string | null) {
  p.run = p.run?.sig === call ? { sig: call, n: p.run.n + 1 } : { sig: call, n: 1 };
  mark(p, 'R2', p.run.n >= r.repeatedTool ? call : null);
  p.errs = err === null ? null : p.errs?.sig === err ? { sig: err, n: p.errs.n + 1 } : { sig: err, n: 1 };
  mark(p, 'R3', p.errs && p.errs.n >= r.repeatedError ? err : null);
  p.recent.push(call);
  if (p.recent.length > 3 * r.cycleRepeats) p.recent.shift();
  mark(p, 'R4', cycle(p.recent, r.cycleRepeats));
}

/** Time from `from` to `to` minus the suspended intervals (`[start, end]`, end Infinity while asleep). */
export function awake(from: number, to: number, sleeps: readonly (readonly [number, number])[]): number {
  let t = to - from;
  for (const [s, e] of sleeps) t -= Math.max(0, Math.min(to, e) - Math.max(from, s));
  return t;
}
