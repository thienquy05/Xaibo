// RED/GREEN harness for the S11-T8 catalog draft. Hand-written subset validator for exactly the
// keywords agents.catalog.schema.draft.json uses. NOT the product validator (that is S11-T9).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type Schema = Record<string, unknown>;
export const BUNDLED_IDS: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini']);
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description']);
const KEYWORDS = new Set(['$defs', '$ref', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minItems', 'maxItems']);

export const loadJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeOk = (t: string, v: unknown) => typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer');

export function validate(root: Schema, value: unknown): string[] {
  const errs: string[] = [];
  const walk = (s: Schema, v: unknown, at: string): void => {
    for (const k of Object.keys(s)) if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) throw new Error(`unsupported keyword ${k}`);
    if (typeof s.$ref === 'string') {
      const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(s.$ref);
      if (!m) throw new Error(`local $ref only: ${s.$ref}`);
      const target = (root.$defs as Record<string, Schema> | undefined)?.[m[1]];
      if (!target) throw new Error(`missing $def ${m[1]}`);
      walk(target, v, at);
    }
    const fail = (kw: string, msg: string) => errs.push(`${at || '/'}: ${kw}: ${msg}`);
    if (s.type !== undefined && !typeOk(s.type as string, v)) return void fail('type', `expected ${s.type}, got ${typeOf(v)}`);
    if ('const' in s && v !== s.const) fail('const', `expected ${JSON.stringify(s.const)}`);
    if (s.enum && !(s.enum as unknown[]).includes(v)) fail('enum', `${JSON.stringify(v)} not allowed`);
    if (typeof v === 'string') {
      if (s.pattern !== undefined && !new RegExp(s.pattern as string, 'u').test(v)) fail('pattern', `${JSON.stringify(v)} !~ ${s.pattern}`);
      const n = [...v].length;
      if (s.minLength !== undefined && n < (s.minLength as number)) fail('minLength', `${n}`);
      if (s.maxLength !== undefined && n > (s.maxLength as number)) fail('maxLength', `${n}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < (s.minItems as number)) fail('minItems', `${v.length}`);
      if (s.maxItems !== undefined && v.length > (s.maxItems as number)) fail('maxItems', `${v.length}`);
      if (s.items) v.forEach((x, i) => walk(s.items as Schema, x, `${at}/${i}`));
    }
    if (typeOf(v) === 'object') {
      const o = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      for (const r of (s.required ?? []) as string[]) if (!(r in o)) fail('required', r);
      for (const [k, x] of Object.entries(o)) {
        if (props[k]) walk(props[k], x, `${at}/${k}`);
        else if (s.additionalProperties === false) fail('additionalProperties', `unknown field ${k}`);
      }
    }
  };
  walk(root, value, '');
  return errs;
}

// Loader rules JSON Schema cannot express: an entry's origin comes from where it was read, never from its content.
export function loaderErrors(entry: unknown, o: { imported: boolean }): string[] {
  const id = (entry as { id?: unknown })?.id;
  return o.imported && typeof id === 'string' && BUNDLED_IDS.has(id) ? [`/id: loader: imported entry shadows bundled id ${id}`] : [];
}

export const checkEntry = (schema: unknown, entry: unknown, o: { imported: boolean }) => {
  const errs = validate(schema as Schema, entry);
  return errs.length ? errs : loaderErrors(entry, o);
};

if (import.meta.main) {
  const here = import.meta.dirname;
  const schema = loadJson(join(here, 'agents.catalog.schema.draft.json'));
  let bad = 0;
  for (const [f, imported] of [['gemini.entry.json', false], ['synthetic-agent.entry.json', true]] as const) {
    const e = checkEntry(schema, loadJson(join(here, f)), { imported });
    console.log(`${e.length ? 'FAIL' : 'ok  '} ${f}${e.length ? `\n  ${e.join('\n  ')}` : ''}`);
    bad += e.length ? 1 : 0;
  }
  for (const f of readdirSync(join(here, 'negative')).sort()) {
    const e = checkEntry(schema, loadJson(join(here, 'negative', f)), { imported: true });
    console.log(`${e.length ? 'ok  ' : 'FAIL'} negative/${f} -> ${e[0] ?? 'accepted (must fail)'}`);
    bad += e.length ? 0 : 1;
  }
  process.exitCode = bad ? 1 : 0;
}
