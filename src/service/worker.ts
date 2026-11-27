// XAIBO-PROD-550 (D-P5-15 item 4): one worker-thread run for the usage ledger (usage/ledger.ts) and Clear usage history
// (usage/clear.ts). The caller passes its own module URL (its worker entry sits at the bottom of that module) and the
// workerData. The worker answers one message: {ok: true, ...} resolves with it, {ok: false} rejects 'store'. Only the
// first outcome counts (the worker's exit follows its message); every other outcome rejects with a fixed code
// (timeout, error, exit-N), never a message text or path. Design review M1: the listeners stay attached after the first
// outcome, so a late 'error' (after terminate on timeout) is absorbed, never uncaught.
import { Worker } from 'node:worker_threads';

export function runWorker<T extends { ok: true }>(url: URL, workerData: unknown, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (f: () => void) => { if (settled) return; settled = true; clearTimeout(timer); f(); };
    const fail = (code: string) => done(() => reject(new Error(code)));
    let w: Worker;
    try { w = new Worker(url, { workerData }); } catch { return fail('error'); } // review M2: no path from a constructor error
    timer = setTimeout(() => { void w.terminate(); fail('timeout'); }, timeoutMs);
    w.once('message', (m: T | { ok: false }) => (m.ok ? done(() => resolve(m)) : fail('store')));
    w.on('error', () => fail('error'));
    w.once('exit', (c) => fail(`exit-${c}`));
  });
}
