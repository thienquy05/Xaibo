// Status-engine observations for unit tests (P3-T08): a hook envelope or one native file line, synthetic ids only.
import type { Observation } from '../../src/service/status/engine.ts';

export const SID = '00000000-0000-4000-8000-0000000f0801';
export const T0 = Date.parse('2026-01-01T00:00:00.000Z');
let n = 0;

export function hookObs(agent: string, payload: Record<string, unknown>, o: { at?: number; id?: string; session?: string } = {}): Extract<Observation, { envelope: unknown }> {
  const session = o.session ?? SID;
  return { source: 'hook', envelope: {
    v: 1, delivery_id: o.id ?? `d-${++n}`, agent, profile_key: 'p1', event: String(payload['hook_event_name'] ?? 'unknown'),
    session_id: session, cwd: '/tmp/xaibo-fixture/status', received_ts: T0 + (o.at ?? 0), payload: { session_id: session, ...payload },
  } };
}

export function fileObs(agent: string, record: Record<string, unknown>, o: { at?: number; offset?: number; session?: string } = {}): Extract<Observation, { source: 'file' }> {
  return { source: 'file', agent, sessionId: o.session ?? SID, file: 'transcript.jsonl', offset: o.offset ?? ++n * 1000,
    line: JSON.stringify(record), receivedTs: T0 + (o.at ?? 0) };
}
