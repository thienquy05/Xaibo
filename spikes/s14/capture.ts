// P6-S14-T1 statusLine helper, run by Claude inside the disposable-profile runner on every status redraw: stdin -> the
// production projection (captureRecord) plus key names, appended to $XAIBO_SPIKE_RAW/<label>/statusline.jsonl.
// Imports only the builtins-only tee module, prints nothing and always exits 0 (review 6).
import { appendFileSync, mkdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { captureRecord } from '../../src/forwarder/statusline-tee.ts';

const CAPTURE_CAP = 256 * 1024; // as the production tee
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const keyPaths = (o: unknown, p = ''): string[] => (isObj(o)
  ? Object.entries(o).flatMap(([k, v]) => (isObj(v) ? keyPaths(v, p + k + '.') : [p + k + (Array.isArray(v) ? '[]' : '')])) : []);

/** One statusLine stdin -> {keys, record}: key names and the production projection only; null for anything else. */
export function captureLine(stdin: string): string | null {
  if (Buffer.byteLength(stdin) > CAPTURE_CAP) return null;
  let v: unknown;
  try { v = JSON.parse(stdin); } catch { return null; }
  if (!isObj(v)) return null;
  return JSON.stringify({ keys: [...new Set(keyPaths(v))].sort().slice(0, 512), record: captureRecord(v) });
}

if (import.meta.main) {
  try {
    const raw = process.env.XAIBO_SPIKE_RAW;
    const label = process.argv[2] ?? '';
    const buf = Buffer.alloc(CAPTURE_CAP + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length;) { r = readSync(0, buf, n, buf.length - n, null); n += r; }
    const line = captureLine(buf.subarray(0, n).toString('utf8')); // over the cap: refused
    if (raw && line && /^[A-Za-z0-9-]{1,64}$/.test(label)) { mkdirSync(join(raw, label), { recursive: true }); appendFileSync(join(raw, label, 'statusline.jsonl'), line + '\n'); }
  } catch { /* silent */ }
  process.exitCode = 0;
}
