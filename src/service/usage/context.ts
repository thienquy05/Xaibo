// Context projection (P2-T07, PRD §5.11, EC-94, EC-93, D-P2-04). Pure: the latest reading of a context generation
// plus one observation -> the next reading. A compaction, a model change or a window change starts a new generation,
// so an old used count is never shown against a new window. Claude's window is only ever a reported statusLine window
// (Phase 3 tee); the model list is not used (D-P2-04). Codex reports its effective window; it is not reduced again.
export type ContextObs =
  | { kind: 'claude-usage'; model: string | null; used: number | null; at: number | null; locator: string }
  | { kind: 'statusline'; model: string | null; window: number | null; used: number | null; at: number | null; locator: string }
  | { kind: 'compaction'; postTokens: number | null; at: number | null; locator: string }
  | { kind: 'codex'; model: string | null; used: number | null; window: number | null; at: number | null; locator: string };

export interface Snapshot {
  generation: number; model: string | null; used: number | null; window: number | null; basis: 'reported' | 'unavailable';
  percentage: number | null; source: 'transcript' | 'statusline' | 'compaction' | 'rollout'; locator: string; asOf: number | null;
}

const SOURCE = { 'claude-usage': 'transcript', statusline: 'statusline', compaction: 'compaction', codex: 'rollout' } as const;
const changed = (a: string | number | null | undefined, b: string | number | null) => a != null && b !== null && a !== b;

export function contextStep(prev: Snapshot | null, o: ContextObs): Snapshot {
  const g = prev?.generation ?? 0;
  let generation = g;
  let model = prev?.model ?? null;
  let window = prev?.window ?? null;
  let used: number | null;
  if (o.kind === 'compaction') {
    generation = prev ? g + 1 : g; // same model and window; a numeric postTokens is an interim reading, else awaiting
    used = o.postTokens;
  } else {
    const nextWindow = o.kind === 'claude-usage' ? window : o.window;
    if (prev && (changed(prev.model, o.model) || changed(prev.window, nextWindow))) {
      generation = g + 1;
      if (o.kind === 'claude-usage') window = null; // the old window belongs to the old model
    }
    if (o.model !== null) model = o.model;
    if (o.kind !== 'claude-usage') window = o.window;
    used = o.used;
  }
  return {
    generation, model, used, window, basis: window === null ? 'unavailable' : 'reported',
    percentage: used !== null && window !== null && window > 0 ? (used * 100) / window : null,
    source: SOURCE[o.kind], locator: o.locator, asOf: o.at,
  };
}
