// P0-T08 reducer: raw recorder lines -> key paths, JSON types, presence counts per event and allowlisted enum
// values only. Free strings never pass: a value is kept only under an allowlisted key and only if it looks like
// an identifier; UUID-like values become <id>, anything else <other>. Non-identifier object keys, and the keys of a
// JSON-Schema `properties` map (tool parameter names), become <key>.
// Usage: reduce.ts --in <raw.jsonl> --out <dir> [--schema] [--enum-keys a,b,…]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const DEFAULT_ENUM_KEYS = ['hook_event_name', 'notification_type', 'type', 'subtype', 'entrypoint', 'source',
  'originator', 'role', 'permission_mode', 'tool_name', 'model', 'version', 'stop_reason'];
const ENUM_VALUE = /^[A-Za-z_][A-Za-z0-9_.-]{0,40}$/;
const KEY_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NEVER_ENUM = /plan|credit|account|email|org|user/i;

interface KeyStat { types: string[]; present: number; values?: string[] }
export type Reduced = Record<string, { count: number; keys: Record<string, KeyStat> }>;

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function enumValue(key: string, v: unknown): string | undefined {
  if (typeof v !== 'string' || NEVER_ENUM.test(key)) return undefined;
  if (UUIDISH.test(v)) return '<id>';
  return ENUM_VALUE.test(v) ? v : '<other>';
}

export function reduce(records: Record<string, unknown>[], enumKeys = DEFAULT_ENUM_KEYS): Reduced {
  const out: Reduced = {};
  const allow = new Set(enumKeys);
  for (const r of records) {
    const ev = String(r.event ?? 'unknown');
    const name = KEY_SEGMENT.test(ev) ? ev : '<other>';
    const bucket = (out[name] ??= { count: 0, keys: {} });
    bucket.count++;
    const seen = new Set<string>();
    const walk = (v: unknown, at: string, key: string) => {
      if (at) {
        const st = (bucket.keys[at] ??= { types: [], present: 0 });
        if (!st.types.includes(typeOf(v))) st.types = [...st.types, typeOf(v)].sort();
        if (!seen.has(at)) { st.present++; seen.add(at); }
        const e = allow.has(key) ? enumValue(key, v) : undefined;
        if (e !== undefined && !st.values?.includes(e)) st.values = [...(st.values ?? []), e].sort();
      }
      if (Array.isArray(v)) v.forEach((x) => walk(x, `${at}[]`, key));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          // Children of a JSON-Schema `properties` map are tool parameter names, which fingerprint the account's tools.
          const seg = KEY_SEGMENT.test(k) && !UUIDISH.test(k) && key !== 'properties' ? k : '<key>';
          walk(x, at ? `${at}.${seg}` : seg, seg);
        }
      }
    };
    walk(r.payload, '', '');
  }
  return out;
}

function main() {
  const { values } = parseArgs({ options: { in: { type: 'string' }, out: { type: 'string' }, schema: { type: 'boolean' }, 'enum-keys': { type: 'string' } } });
  if (!values.in || !values.out) { console.log('usage: reduce.ts --in <raw.jsonl> --out <dir> [--schema] [--enum-keys a,b]'); return 2; }
  const records = readFileSync(values.in, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
  });
  const enumKeys = values['enum-keys'] ? [...DEFAULT_ENUM_KEYS, ...values['enum-keys'].split(',')] : DEFAULT_ENUM_KEYS;
  const reduced = reduce(records, enumKeys);
  mkdirSync(values.out, { recursive: true });
  writeFileSync(path.join(values.out, 'reduced.json'), `${JSON.stringify(reduced, null, 2)}\n`);
  if (values.schema) {
    for (const [ev, { keys }] of Object.entries(reduced)) {
      const schema = Object.fromEntries(Object.entries(keys).map(([k, s]) => [k, s.types]));
      writeFileSync(path.join(values.out, `${ev}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`);
    }
  }
  return 0;
}

if (import.meta.main) process.exitCode = main();
