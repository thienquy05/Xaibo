// XAIBO-PROD-409 (P4-T05a2): read-time derivations for the session workspace port. Stored rows stay as they are; the
// raw record, timestamps and status evidence already hold what the workspace shows. Unknown stays null or absent.
import { isObj } from '../shared/ipc.ts';
import { CONFIRMED_ONLY, type Confidence, type Ev } from './status/engine.ts';

type Obj = Record<string, unknown>;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The `message` object of a Claude record, or undefined for anything unparsable. */
export function message(raw: string): Obj | undefined {
  try {
    const r: unknown = JSON.parse(raw);
    return isObj(r) && isObj(r.message) ? r.message : undefined;
  } catch { return undefined; }
}

/** Claude `message`: visible text and available reasoning (thinking blocks) apart (PRD §5.6); tool blocks belong to
 *  tools. Takes the parsed object, so a caller parses each record once (T05b1 review 1). */
export function claudeMessagePartsOf(msg: unknown): { text: string | null; reasoning: string | null } {
  const content = isObj(msg) ? msg.content : undefined;
  if (nonEmpty(content)) return { text: content, reasoning: null };
  if (!Array.isArray(content)) return { text: null, reasoning: null };
  const text: string[] = [], reasoning: string[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'text' && nonEmpty(b.text)) text.push(b.text);
    if (b.type === 'thinking' && nonEmpty(b.thinking)) reasoning.push(b.thinking);
  }
  return { text: text.join('\n') || null, reasoning: reasoning.join('\n') || null };
}

/** A Claude result record's `is_error` for one call as reported; null when absent, not boolean or unparsable. */
export function claudeCallError(raw: string, callId: string): boolean | null {
  const content = message(raw)?.content;
  const b: unknown = Array.isArray(content) ? content.find((x) => isObj(x) && x.type === 'tool_result' && x.tool_use_id === callId) : undefined;
  return isObj(b) && typeof b.is_error === 'boolean' ? b.is_error : null;
}

export interface Stamp { ts: number | null; source: string }
/** EC-08: a duration comes from one source only; cross-source, missing or negative -> null. */
export function callDuration(args: Stamp | undefined, result: Stamp | undefined): number | null {
  if (!args || !result || args.source !== result.source) return null;
  if (!Number.isFinite(args.ts) || !Number.isFinite(result.ts)) return null;
  const ms = result.ts! - args.ts!;
  return ms >= 0 ? ms : null;
}

export type Approval = 'not_requested' | 'requested' | 'approved' | 'denied';
/** Status evidence with its stored confidence (absent = confirmed). */
export type ConfEv = Ev & { conf?: Confidence };
/** Per-call approval state from normalized status evidence in source order, mirroring the status engine: a duplicate
 *  start or a start of an ended call is ignored, subagent (child) starts are never a join target, and only a call still
 *  in flight changes state. An id-less permission request joins the latest started call still in flight (Claude
 *  PermissionRequest has no tool_use_id). Unseen calls stay absent. Amortized O(1) per event (review M2). */
export function callApprovals(evs: ConfEv[]): Map<string, Approval> {
  const state = new Map<string, Approval>();
  const inflight = new Set<string>();
  const stack: string[] = []; // start order of in-flight join targets; ended ids are popped lazily
  const ended = new Set<string>();
  // Re-review N1: an end that sorts before its start (engine.ts tool.end) still ends the call, as the engine's done set;
  // XAIBO-PROD-444: as there, only a confirmed end does (an inferred one only ends the flight).
  const land = (id: string, done = true) => { inflight.delete(id); if (done) ended.add(id); };
  for (const e of evs) {
    if (e.conf === 'inferred' && CONFIRMED_ONLY.has(e.k)) continue; // XAIBO-PROD-455: the engine's filter (inferred request/resolve)
    switch (e.k) {
      case 'tool.start':
        if (!state.has(e.id)) state.set(e.id, 'not_requested');
        if (ended.has(e.id) || inflight.has(e.id)) break;
        inflight.add(e.id);
        if (!e.child) stack.push(e.id); // re-review N2: a child takes explicit-id requests but is never an id-less target
        break;
      case 'request': {
        if (e.kind !== 'permission') break;
        while (stack.length > 0 && !inflight.has(stack.at(-1)!)) stack.pop();
        const id = e.id ?? stack.at(-1);
        if (id !== undefined && inflight.has(id)) state.set(id, 'requested');
        break;
      }
      case 'tool.end':
        if (inflight.has(e.id) && state.get(e.id) === 'requested') state.set(e.id, 'approved');
        land(e.id, e.conf !== 'inferred');
        break;
      case 'resolve':
        if (e.outcome === 'denied' && inflight.has(e.id) && state.get(e.id) === 'requested') { state.set(e.id, 'denied'); land(e.id); }
        break;
      case 'tool.rejected':
        if (!inflight.has(e.id)) break; // XAIBO-PROD-444: as the engine, only a call in flight is denied or interrupted
        if (state.get(e.id) === 'requested') state.set(e.id, 'denied');
        land(e.id);
        break;
      default:
    }
  }
  return state;
}

export const MAX_MODEL = 200;
