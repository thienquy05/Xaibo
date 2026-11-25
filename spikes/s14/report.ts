// P6-S14-T1 numberless evidence serializer: one row per agent/version/method with only these columns, each checked
// against a fixed enum or pattern. Only software versions and static schema identifiers may hold digits. A bad row
// becomes {result: invalid}; a failure never throws and never echoes input.
import { FIELD, ID, METHODS, SOURCES, VERSION } from './signals.ts';

const REASONS = ['none', 'no-access', 'no-candidate', 'alternatives-not-run', 'same-signal-multiple-methods', 'signal-absent', 'not-repeatable',
  'not-production-reachable', 'guard-diff', 'version-changed', 'collection-truncated', 'collection-empty'] as const;
const oneOf = (xs: readonly string[]) => (v: unknown) => typeof v === 'string' && xs.includes(v);
const fields = (v: unknown) => Array.isArray(v) && v.length <= 64 && v.every((f) => typeof f === 'string' && FIELD.test(f));
const COLUMNS: [string, (v: unknown) => boolean][] = [
  ['agent', oneOf(['claude', 'codex', 'agy'])],
  ['version', (v) => v === 'unavailable' || (typeof v === 'string' && VERSION.test(v))],
  ['method', oneOf([...METHODS, 'google-sign-in'])], // owner-tested method; Google sign-in is not a subscription
  ['surface', oneOf(SOURCES)],
  ['fields', fields],
  ['predicate', (v) => v === null || (typeof v === 'string' && ID.test(v))],
  ['signal', oneOf(['present', 'absent', 'ambiguous', 'unavailable'])],
  ['repeatable', oneOf(['yes', 'no', 'unavailable'])],
  ['result', oneOf(['verified', 'negative', 'not-run', 'invalid'])],
  ['guard', oneOf(['MATCH', 'DIFF', 'not-run'])],
  ['reachable', oneOf(['yes', 'no', 'unavailable'])],
  ['reason', oneOf(REASONS)],
];
export type Row = Record<string, unknown>;

function one(r: unknown): Row {
  try {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return { result: 'invalid', reason: 'malformed-row' };
    const out: Row = {};
    for (const [k, ok] of COLUMNS) {
      const v = (r as Row)[k];
      if (!ok(v)) return { result: 'invalid', reason: 'malformed-row' };
      out[k] = Array.isArray(v) ? [...v] : v;
    }
    return out;
  } catch { return { result: 'invalid', reason: 'serializer-failed' }; }
}

export function serialize(rows: unknown): string {
  try { return Array.isArray(rows) ? JSON.stringify(rows.map(one)) : '[]'; } catch { return '[]'; }
}

/** Key-path names only, deduplicated and sorted; a key with a digit or any non-identifier text is dropped (review 7:
 *  keys can be data-derived, so the evidence stays numberless). */
const KEY = /^[A-Za-z_]+(\.[A-Za-z_]+)*$/;
export const keyNames = (xs: Iterable<string>) => [...new Set([...xs].filter((k) => KEY.test(k.replaceAll('[]', ''))))].sort().slice(0, 1024);
