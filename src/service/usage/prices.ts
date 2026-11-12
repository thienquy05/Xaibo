// Prices (P2-T09, EC-96, PRD §5.12): the bundled integrations/models.json plus the private <dataDir>/models.override.json,
// an untrusted local file: opened without following symlinks or blocking (regular file only, 1 MiB cap), parsed and
// validated strictly. Override entries replace bundled ones by exact id. Each accepted table is written once (by
// content hash) to the immutable price_revisions and named current in kv, so an invalid edit, even across a restart,
// keeps the last valid revision; existing estimates keep theirs (no repricing). Owner-set fallbacks (D-P2-06) cover
// exact model ids, optionally one agent. Errors are fixed codes, never file content. No network.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../../shared/log.ts';
import { loadModels, validateModels, type ModelEntry, type ModelList, type Rates } from './models.ts';

export type PriceError = 'override_unreadable' | 'override_not_regular' | 'override_too_large' | 'override_json' | 'override_schema';
export interface Prices { table: ModelList; source: 'bundled' | 'override'; revisionId: number | null; error: PriceError | null }
export interface PriceRates {
  modelId: string; rates: Rates; tiers?: ModelEntry['tiers']; qualifiers?: Record<string, string[]>; basis: 'token_table' | 'owner_fallback';
}
export interface PriceOptions { db: DatabaseSync | null; overridePath: string; bundled?: URL; previous?: Prices | null; log?: Logger }

const MAX_BYTES = 1 << 20;
const KV = 'prices.current';
const SCHEMA_VERSION = 1;

/** null = no override file. */
function readOverride(file: string): { value: unknown } | { error: PriceError } | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); // a FIFO never blocks the service
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? null : { error: code === 'ELOOP' ? 'override_not_regular' : 'override_unreadable' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: 'override_not_regular' };
    if (st.size > MAX_BYTES) return { error: 'override_too_large' };
    const buf = Buffer.alloc(MAX_BYTES + 1); // bounded even if the file grows after fstat
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = readSync(fd, buf, n, buf.length - n, null);
    if (n > MAX_BYTES) return { error: 'override_too_large' };
    try { return { value: JSON.parse(buf.subarray(0, n).toString('utf8')) as unknown }; } catch { return { error: 'override_json' }; }
  } catch {
    return { error: 'override_unreadable' };
  } finally {
    closeSync(fd);
  }
}

/** The override merged onto the bundled list, or null when it is invalid (schema, unknown source, duplicate id). */
function merge(bundled: ModelList, value: unknown): ModelList | null {
  const o = value as ModelList;
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  const sources = isObject && Array.isArray(o.sources)
    ? [...bundled.sources.filter((s) => !o.sources.some((x) => x?.id === s.id)), ...o.sources] : undefined;
  // The override is checked as written, except that its entries may cite bundled source ids.
  if (validateModels(sources ? { ...o, sources } : value).length) return null;
  const ids = new Set(o.models.map((m) => m.id));
  return {
    ...bundled, revision: o.revision, prices_as_of: o.prices_as_of, sources: sources!,
    models: [...bundled.models.filter((m) => !ids.has(m.id)), ...o.models], ...(o.fallbacks ? { fallbacks: o.fallbacks } : {}),
  };
}

function accept(db: DatabaseSync, source: Prices['source'], table: ModelList, bundledRevision: string): number {
  const body = JSON.stringify({ bundled_revision: bundledRevision, table });
  const hash = createHash('sha256').update(body).digest('hex');
  db.prepare(`INSERT INTO price_revisions (schema_version, source, revision, prices_as_of, content_hash, body, accepted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (content_hash) DO NOTHING`).run(SCHEMA_VERSION, source, table.revision, table.prices_as_of, hash, body, Date.now());
  const id = Number((db.prepare('SELECT id FROM price_revisions WHERE content_hash = ?').get(hash) as { id: number }).id);
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(KV, String(id));
  return id;
}

function lastValid(db: DatabaseSync | null, previous: Prices | null | undefined): Omit<Prices, 'error'> | undefined {
  if (previous) return { table: previous.table, source: previous.source, revisionId: previous.revisionId };
  const id = db && (db.prepare('SELECT value FROM kv WHERE key = ?').get(KV) as { value: string } | undefined)?.value;
  const row = id ? db.prepare('SELECT id, source, body FROM price_revisions WHERE id = ?').get(Number(id)) as { id: number; source: Prices['source']; body: string } | undefined : undefined;
  return row && { table: (JSON.parse(row.body) as { table: ModelList }).table, source: row.source, revisionId: Number(row.id) };
}

/** Loads at boot and on reloadPrices. Throws only for an invalid bundled list (a build error). db null = read-only store. */
export function loadPrices(o: PriceOptions): Prices {
  const bundled = loadModels(o.bundled);
  if (bundled.fallbacks) throw new Error('the bundled model list must not carry fallbacks');
  const read = readOverride(o.overridePath);
  let error: PriceError | null = read && 'error' in read ? read.error : null;
  let table = bundled;
  let source: Prices['source'] = 'bundled';
  if (read && 'value' in read) {
    const merged = merge(bundled, read.value);
    if (merged) { table = merged; source = 'override'; } else error = 'override_schema';
  }
  if (error) {
    o.log?.log('prices_invalid', { error });
    const last = lastValid(o.db, o.previous);
    if (last) return { ...last, error };
  }
  return { table, source, revisionId: o.db ? accept(o.db, source, table, bundled.revision) : null, error };
}

/** Verified table rates for the exact model id, else an in-scope owner fallback, else null (~$ unavailable). */
export function ratesFor(table: ModelList, agent: string, modelId: string | null): PriceRates | null {
  if (!modelId) return null;
  const m = table.models.find((x) => x.id === modelId);
  if (m?.prices_verified && m.rates) return { modelId, rates: m.rates, ...(m.tiers ? { tiers: m.tiers } : {}), ...(m.qualifiers ? { qualifiers: m.qualifiers } : {}), basis: 'token_table' };
  const f = table.fallbacks?.find((x) => x.models.includes(modelId) && (!x.agent || x.agent === agent));
  return f ? { modelId, rates: f.rates, ...(f.qualifiers ? { qualifiers: f.qualifiers } : {}), basis: 'owner_fallback' } : null;
}
