// Token normalization (P2-T06, PRD §5.5/§5.6, EC-93). Pure: raw usage objects -> normalized components (uncached
// input, cache read, cache write with classes, output) and per-component completeness. Missing is NULL, never 0.
// Claude maps directly (S9/S13). Codex: cached ⊂ input, reasoning ⊂ output (S9); cache_write has no established
// relation to input (S13), so it stays NULL with a gap and the raw value is kept by the caller. agy (D-P2-02):
// cache read inside input, no cache-write component, reasoning unavailable.
export type Completeness = 'reported' | 'missing' | 'relation-unverified' | 'unavailable';
export interface Usage {
  uncachedInput: number | null; cacheRead: number | null; cacheWrite: number | null; cacheWriteClasses: Record<string, number> | null;
  output: number | null; completeness: { uncachedInput: Completeness; cacheRead: Completeness; cacheWrite: Completeness; output: Completeness };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const c = (v: number | null): Completeness => (v === null ? 'missing' : 'reported');

/** input − cached when both are reported and consistent; otherwise NULL (never negative). */
const inside = (input: number | null, cached: number | null) => (input !== null && cached !== null && cached <= input ? input - cached : null);

export function claudeUsage(u: Obj): Usage {
  const uncachedInput = num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  const output = num(u.output_tokens);
  const cc = isObj(u.cache_creation) ? u.cache_creation : undefined;
  const classes: Record<string, number> = {};
  if (cc && num(cc.ephemeral_5m_input_tokens) !== null) classes['5m'] = num(cc.ephemeral_5m_input_tokens)!;
  if (cc && num(cc.ephemeral_1h_input_tokens) !== null) classes['1h'] = num(cc.ephemeral_1h_input_tokens)!;
  return {
    uncachedInput, cacheRead, cacheWrite, cacheWriteClasses: Object.keys(classes).length ? classes : null, output,
    completeness: { uncachedInput: c(uncachedInput), cacheRead: c(cacheRead), cacheWrite: c(cacheWrite), output: c(output) },
  };
}

export function codexUsage(u: Obj): Usage {
  const cacheRead = num(u.cached_input_tokens);
  const uncachedInput = inside(num(u.input_tokens), cacheRead);
  const output = num(u.output_tokens); // reasoning_output_tokens ⊂ output_tokens (S9)
  return {
    uncachedInput, cacheRead, cacheWrite: null, cacheWriteClasses: null, output,
    completeness: { uncachedInput: c(uncachedInput), cacheRead: c(cacheRead), cacheWrite: 'relation-unverified', output: c(output) },
  };
}

export function agyUsage(u: Obj): Usage {
  const cacheRead = num(u.cache_read_tokens);
  const uncachedInput = inside(num(u.input_tokens), cacheRead);
  const output = num(u.output_tokens);
  return {
    uncachedInput, cacheRead, cacheWrite: null, cacheWriteClasses: null, output,
    completeness: { uncachedInput: c(uncachedInput), cacheRead: c(cacheRead), cacheWrite: 'unavailable', output: c(output) },
  };
}

export interface CounterState { segment: number; total: number }
/** One cumulative `total_tokens` reading against the session's last one: a rise advances (consumption and a request);
 *  an equal reading is a duplicate (+0); a fall starts a new counter segment from 0, never a negative delta. */
export function codexStep(prev: CounterState | null, total: number): CounterState & { advanced: boolean } {
  if (prev === null) return { segment: 0, total, advanced: total > 0 };
  if (total > prev.total) return { segment: prev.segment, total, advanced: true };
  if (total === prev.total) return { ...prev, advanced: false };
  return { segment: prev.segment + 1, total, advanced: total > 0 };
}

export interface RateWindow { kind: string; durationMinutes: number | null; usedPercent: number | null; resetsAt: number | null }
/** token_count rate_limits (S9): primary/secondary windows, `resets_at` epoch seconds -> ms; above 100% kept. */
export function codexRateLimits(rl: Obj): { limitId: string | null; plan: string | null; credits: unknown; windows: RateWindow[] } {
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const windows = (['primary', 'secondary'] as const).flatMap((kind) => {
    const w = rl[kind];
    if (!isObj(w)) return [];
    const reset = num(w.resets_at);
    return [{ kind, durationMinutes: num(w.window_minutes), usedPercent: num(w.used_percent), resetsAt: reset === null ? null : reset * 1000 }];
  });
  return { limitId: str(rl.limit_id), plan: str(rl.plan_type), credits: rl.credits ?? null, windows };
}

// D-P2-03: the Codex 0.160.0 token_usage_record usage objects and their keys (S9 schema); anything else is drift.
const RECORD_USAGE = ['usage', 'turn_token_usage', 'thread_token_usage'];
const USAGE_KEYS = ['cache_write_input_tokens', 'cached_input_tokens', 'input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
export function tokenRecordDrift(payload: Obj): boolean {
  return !RECORD_USAGE.every((k) => {
    const u = payload[k];
    return isObj(u) && Object.keys(u).length === USAGE_KEYS.length && USAGE_KEYS.every((key) => num(u[key]) !== null);
  });
}
