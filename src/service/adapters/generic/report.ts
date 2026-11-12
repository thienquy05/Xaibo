// Report v1 status map (P3-T13a; PRD §5.10, §6.8; EC-83): a validated report event becomes normalized status evidence
// under the same correlation rules as hooks: a request and its resolution join only by request_id (none = matches
// nothing), tools by item_id, content is progress, a usage snapshot replaces the previous one (not additive). Unknown
// kinds and invalid or unsupported events are null (reduced coverage), never a wait. Content is never copied.
import { parseReport } from '../../../shared/report/schema.ts';
import type { Envelope } from '../../../shared/hook-protocol.ts';
import type { Ev } from '../../status/engine.ts';
import { sigField } from '../../status/rules.ts';

const OUTCOME: Record<string, string> = { deny: 'denied', decline: 'declined', cancel: 'cancelled' };
const USAGE: Record<string, string> = { input_tokens: 'input', output_tokens: 'output', cache_read_tokens: 'cacheRead', cache_write_tokens: 'cacheWrite', reasoning_tokens: 'reasoning' };
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

export function reportEvidence(e: Envelope): Ev[] | null {
  const r = parseReport(e.payload);
  if (!r.ok || r.event.session_id !== e.session_id) return null; // the envelope's session is the report's own (review M4)
  const x = r.event, p = x.payload;
  const tail: Ev[] = x.model || x.effort ? [{ k: 'model', ...(x.model ? { id: x.model.id } : {}), ...(x.effort ? { effort: x.effort } : {}) }] : [];
  const outcome = (k: string) => (typeof p[k] === 'string' && Object.hasOwn(OUTCOME, p[k]) ? OUTCOME[p[k]]! : null);
  const tool = typeof p['tool'] === 'string' && p['tool'].length <= 256 ? p['tool'] : undefined;
  let evs: Ev[] | null;
  switch (x.event) {
    case 'session.start': evs = [{ k: 'session.start' }]; break;
    case 'session.end': evs = [{ k: 'session.end' }]; break;
    case 'turn.start': evs = [{ k: 'turn.start', typed: true, ...(x.turn_id ? { turn: x.turn_id } : {}) }]; break;
    case 'turn.end': evs = [{ k: 'turn.end' }]; break;
    case 'turn.error': evs = [{ k: 'turn.error' }]; break;
    // Without a request_id nothing could ever resolve it: reduced coverage, not a permanent wait (review M3).
    case 'permission.request': evs = x.request_id ? [{ k: 'request', kind: 'permission', id: x.request_id }] : null; break;
    case 'input.request': evs = x.request_id ? [{ k: 'request', kind: 'input', id: x.request_id }] : null; break;
    case 'permission.resolve': evs = x.request_id ? [{ k: 'resolve', id: x.request_id, outcome: outcome('decision') }] : []; break;
    case 'input.resolve': evs = x.request_id ? [{ k: 'resolve', id: x.request_id, outcome: outcome('action') }] : []; break;
    case 'tool.start': evs = x.item_id ? [{ k: 'tool.start', id: x.item_id, ...(tool ? { tool } : {}), ...sigField(p['args'], tool) }] : null; break;
    case 'tool.end': evs = x.item_id ? [{ k: 'tool.end', id: x.item_id, ...sigField(p['result']), ...(p['ok'] === false ? { err: true as const } : {}) }] : null; break;
    case 'content.upsert': evs = [{ k: 'activity' }]; break;
    case 'usage.snapshot': {
      // Known counters only, renamed to the engine's usage keys (review M2): payload key names never reach the store.
      const usage = Object.fromEntries(Object.entries(USAGE).filter(([k]) => Object.hasOwn(p, k) && count(p[k])).map(([k, n]) => [n, p[k] as number]));
      evs = [{ k: 'activity' }, ...(Object.keys(usage).length ? [{ k: 'usage' as const, key: `snapshot:${x.producer_id}`, usage }] : [])];
      break;
    }
    default: evs = null;
  }
  return evs && [...evs, ...tail];
}
