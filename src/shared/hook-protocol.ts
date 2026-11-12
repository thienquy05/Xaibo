// Hook wire protocol v1 (P3-T02, §7.3, EC-32). A frame is a 4-byte big-endian length plus UTF-8 JSON, 1..1 MiB. Every
// connection starts with a hello {v, token}; then envelopes, each answered by an ack. Validation is strict (exact keys,
// bounded strings) and failures are fixed codes, never field values or parser messages. Shared by the forwarder (P3-T03)
// and the service socket; no `v - 1` path until a second version exists.
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME = 1 << 20;

export interface Hello { v: 1; token: string }
export interface Envelope {
  v: 1; delivery_id: string; agent: string; profile_key: string; event: string; session_id: string | null;
  cwd: string | null; received_ts: number; payload: Record<string, unknown> | null; truncated?: boolean; malformed?: boolean;
}
export interface Ack { v: 1; delivery_id: string | null; status: 'accepted' | 'rejected'; code: string }

export class FrameError extends Error {
  readonly code: 'oversize' | 'empty' | 'json';
  constructor(code: FrameError['code']) {
    super(`hook frame refused: ${code}`);
    this.code = code;
  }
}

const HEADER = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_KEY = 128;
const MAX_SESSION = 256;
const MAX_CWD = 4096;
const MAX_TOKEN = 256;
const MAX_CODE = 64;
const ENVELOPE_KEYS = new Set(['v', 'delivery_id', 'agent', 'profile_key', 'event', 'session_id', 'cwd', 'received_ts', 'payload', 'truncated', 'malformed']);
const REQUIRED = ['v', 'delivery_id', 'agent', 'profile_key', 'event', 'session_id', 'cwd', 'received_ts', 'payload'];

export function encodeFrame(msg: Hello | Envelope | Ack | Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (body.length > MAX_FRAME) throw new FrameError('oversize');
  const header = Buffer.alloc(HEADER);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/**
 * Incremental decoder: push chunks, get whole parsed frames. Bytes are kept as received (never allocated from the
 * header), and a bad header throws before its body is buffered.
 */
export function createDecoder(): (chunk: Buffer) => unknown[] {
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let chunks: Buffer[] = [];
  let have = 0;
  let need = -1; // body length once the header is known
  const take = (n: number) => {
    const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, have);
    chunks = n < have ? [all.subarray(n)] : [];
    have -= n;
    return all.subarray(0, n);
  };
  return (chunk) => {
    const out: unknown[] = [];
    if (chunk.length) { chunks.push(chunk); have += chunk.length; }
    for (;;) {
      if (need < 0) {
        if (have < HEADER) return out;
        need = take(HEADER).readUInt32BE(0);
        if (need === 0) throw new FrameError('empty');
        if (need > MAX_FRAME) throw new FrameError('oversize');
      }
      if (have < need) return out;
      const body = take(need);
      need = -1;
      try { out.push(JSON.parse(utf8.decode(body))); } catch { throw new FrameError('json'); }
    }
  };
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown, max: number) => typeof x === 'string' && x.length > 0 && x.length <= max;
const strOrNull = (x: unknown, max: number) => x === null || str(x, max);

export function parseHello(x: unknown): Hello | null {
  if (!isObject(x) || Object.keys(x).length !== 2 || x['v'] !== PROTOCOL_VERSION || !str(x['token'], MAX_TOKEN)) return null;
  return x as unknown as Hello;
}

export function parseEnvelope(x: unknown): { ok: true; envelope: Envelope } | { ok: false; code: 'version' | 'shape' } {
  if (!isObject(x)) return { ok: false, code: 'shape' };
  if (x['v'] !== PROTOCOL_VERSION) return { ok: false, code: 'version' };
  const ok = Object.keys(x).every((k) => ENVELOPE_KEYS.has(k)) && REQUIRED.every((k) => Object.hasOwn(x, k))
    && typeof x['delivery_id'] === 'string' && UUID.test(x['delivery_id'])
    && typeof x['agent'] === 'string' && AGENT.test(x['agent'])
    && str(x['profile_key'], MAX_KEY) && str(x['event'], MAX_KEY)
    && strOrNull(x['session_id'], MAX_SESSION) && strOrNull(x['cwd'], MAX_CWD)
    && typeof x['received_ts'] === 'number' && Number.isFinite(x['received_ts']) && x['received_ts'] >= 0
    && (x['payload'] === null || isObject(x['payload']))
    && ['truncated', 'malformed'].every((k) => x[k] === undefined || typeof x[k] === 'boolean');
  return ok ? { ok: true, envelope: x as unknown as Envelope } : { ok: false, code: 'shape' };
}

export function parseAck(x: unknown): Ack | null {
  if (!isObject(x) || Object.keys(x).length !== 4 || x['v'] !== PROTOCOL_VERSION) return null;
  const id = x['delivery_id'];
  if (!(id === null || (typeof id === 'string' && UUID.test(id)))) return null;
  if (x['status'] !== 'accepted' && x['status'] !== 'rejected') return null;
  return str(x['code'], MAX_CODE) ? (x as unknown as Ack) : null;
}
