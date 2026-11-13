// T0 emitter (P3-T16a, plan §3.5): runs the packaged hook shim the way an agent dispatches a hook, and joins the
// XAIBO_PERF_TRACE=1 lines (service commit and delta, main paint ack) on one monotonic clock: process.hrtime here,
// in the service and in main. IDs and timings only.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
const lines = (f: string): Line[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.endsWith('}')).map((l) => JSON.parse(l) as Line) : []);

/** The service and main trace files of one data dir. */
export class Trace {
  readonly #service: string;
  readonly #main: string;
  constructor(dataDir: string) {
    this.#service = path.join(dataDir, 'logs', 'perf-trace-service.jsonl');
    this.#main = path.join(dataDir, 'logs', 'perf-trace-main.jsonl');
  }

  /** Waits for the commit carrying `id` (or, with id null, the first commit carrying an id) stamped at or after
   *  `notBefore` (the emit's hrtime: an earlier commit cannot be its own; review M2), then the delta carrying it and
   *  that delta's paint ack. */
  async join(id: string | null, timeoutMs: number, notBefore: bigint): Promise<{ id: string; commit: bigint; delta: bigint; paint: bigint }> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const service = lines(this.#service);
      const commits = service.filter((l) => l.ev === 'commit' && BigInt(l.t) >= notBefore);
      const c = id === null ? commits.find((x) => x.ids?.length) : commits.find((x) => x.ids?.includes(id));
      const cid = id ?? c?.ids?.[0];
      const d = cid ? service.find((l) => l.ev === 'delta' && l.ids?.includes(cid)) : undefined;
      const p = d ? lines(this.#main).find((l) => l.ev === 'paint' && l.delta === d.delta) : undefined;
      if (c && d && p) return { id: cid!, commit: BigInt(c.t), delta: BigInt(d.t), paint: BigInt(p.t) };
      if (Date.now() > end) throw new Error(`trace join timed out (${c ? (d ? 'paint' : 'delta') : 'commit'})`);
      await sleep(5);
    }
  }
}
