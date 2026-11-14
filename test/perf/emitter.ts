// T0 emitter (P3-T16a, plan §3.5): runs the packaged hook shim the way an agent dispatches a hook, and joins the
// XAIBO_PERF_TRACE=1 lines (service commit and delta, main paint ack) on one monotonic clock: process.hrtime here,
// in the service and in main. IDs and timings only.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { deployShim } from '../../src/service/adapters/claude/setup.ts';
import { REPO, sleep } from './app.ts';

export const RESOURCES = path.join(REPO, 'release', 'mac-arm64', 'Xaibo.app', 'Contents', 'Resources', 'bin');
/** The packaged helpers installed as Connect would (<data>/integrations/bin); returns the hook shim. */
export const installHelpers = (dataDir: string) => deployShim(dataDir, {
  hook: path.join(RESOURCES, 'xaibo-hook'), forwarder: path.join(RESOURCES, 'xaibo-forwarder'), statusline: path.join(RESOURCES, 'xaibo-statusline'),
});

export const now = () => process.hrtime.bigint();
export const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;

/** Runs `<shim> hook <agent> <profile>` with the payload on stdin; hrtime at spawn and at exit. */
export function emit(shim: string, agent: string, profile: string, payload: object): Promise<{ t0: bigint; exit: bigint }> {
  return new Promise((resolve, reject) => {
    const t0 = now();
    const c = spawn(shim, ['hook', agent, profile], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    c.on('error', reject);
    c.on('close', () => resolve({ t0, exit: now() }));
    c.stdin.end(JSON.stringify(payload));
  });
}

type Line = { ev: string; ids?: string[]; delta?: number; t: string };

/** Lines of an append-only JSONL file, read incrementally (P3-T16d review: re-reading a large trace every poll competed
 *  with the app under test). */
class Tail {
  readonly #file: string;
  #offset = 0;
  #rest = '';
  readonly lines: Line[] = [];
  constructor(file: string) { this.#file = file; }
  read(): Line[] {
    if (!existsSync(this.#file)) return this.lines;
    const fd = openSync(this.#file, 'r');
    try {
      const buf = Buffer.alloc(1 << 20);
      for (let n; (n = readSync(fd, buf, 0, buf.length, this.#offset)) > 0;) {
        this.#offset += n;
        const parts = (this.#rest + buf.subarray(0, n).toString('utf8')).split('\n');
        this.#rest = parts.pop()!;
        for (const l of parts) if (l.endsWith('}')) this.lines.push(JSON.parse(l) as Line);
      }
    } finally { closeSync(fd); }
    return this.lines;
  }
}

/** The service and main trace files of one data dir. */
export class Trace {
  readonly #service: Tail;
  readonly #main: Tail;
  constructor(dataDir: string) {
    this.#service = new Tail(path.join(dataDir, 'logs', 'perf-trace-service.jsonl'));
    this.#main = new Tail(path.join(dataDir, 'logs', 'perf-trace-main.jsonl'));
  }

  /** Waits for the commit carrying `id` (or, with id null, the first commit carrying an id) stamped at or after
   *  `notBefore` (the emit's hrtime: an earlier commit cannot be its own; review M2), then the delta carrying it and
   *  that delta's paint ack. */
  async join(id: string | null, timeoutMs: number, notBefore: bigint): Promise<{ id: string; commit: bigint; delta: bigint; paint: bigint }> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const service = this.#service.read();
      const commits = service.filter((l) => l.ev === 'commit' && BigInt(l.t) >= notBefore);
      const c = id === null ? commits.find((x) => x.ids?.length) : commits.find((x) => x.ids?.includes(id));
      const cid = id ?? c?.ids?.[0];
      const d = cid ? service.find((l) => l.ev === 'delta' && l.ids?.includes(cid)) : undefined;
      const p = d ? this.#main.read().find((l) => l.ev === 'paint' && l.delta === d.delta) : undefined;
      if (c && d && p) return { id: cid!, commit: BigInt(c.t), delta: BigInt(d.t), paint: BigInt(p.t) };
      if (Date.now() > end) throw new Error(`trace join timed out (${c ? (d ? 'paint' : 'delta') : 'commit'})`);
      await sleep(5);
    }
  }
}
