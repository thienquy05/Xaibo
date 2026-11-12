// Tool-call merge (P2-T05, EC-10, PRD §5.5): hook, transcript/rollout and OTel observations of one tool call join on
// the native call id (tool_use_id / call_id) into one ToolCall with combined provenance. The result never depends on
// arrival order; an observation without an id stays its own unlinked call (never joined by timing or name).
export interface ToolCallObservation { source: string; callId: string | null; tool?: string; argsEventId?: number; resultEventId?: number }
export interface ToolCall { callId: string | null; sources: string[]; tool: string | null; argsEventId: number | null; resultEventId: number | null }

// Field precedence follows the status precedence (hooks before native files before OTel); unknown sources last.
const RANK = ['hook', 'transcript', 'rollout', 'otel'];
const rank = (s: string) => { const i = RANK.indexOf(s); return i < 0 ? RANK.length : i; };
const byRank = (a: ToolCallObservation, b: ToolCallObservation) => rank(a.source) - rank(b.source) || (a.tool ?? '').localeCompare(b.tool ?? '');

function merge(callId: string | null, group: ToolCallObservation[]): ToolCall {
  const g = [...group].sort(byRank);
  const ids = (k: 'argsEventId' | 'resultEventId') => g.flatMap((o) => (o[k] === undefined ? [] : [o[k]]));
  const first = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
  return {
    callId, sources: [...new Set(g.map((o) => o.source))].sort(), tool: g.find((o) => o.tool !== undefined)?.tool ?? null,
    argsEventId: first(ids('argsEventId')), resultEventId: first(ids('resultEventId')),
  };
}

/** Linked calls first, in call-id order; then each id-less observation as its own call, in input order. */
export function mergeToolCalls(observations: ToolCallObservation[]): ToolCall[] {
  const groups = new Map<string, ToolCallObservation[]>();
  for (const o of observations) if (o.callId !== null) groups.set(o.callId, [...(groups.get(o.callId) ?? []), o]);
  return [
    ...[...groups.keys()].sort().map((id) => merge(id, groups.get(id)!)),
    ...observations.filter((o) => o.callId === null).map((o) => merge(null, [o])),
  ];
}
