// XAIBO-PROD-552 (D-P5-20/22 investigation, Codex round 2): content-free service counters for the perf trace. Always
// counted (integer increments only); index.ts writes them, with the process memory, only to the test-only perf trace
// (XAIBO_PERF_TRACE=1), never to IPC or the service log. Counts and milliseconds only: no paths, ids, SQL or payloads.
// ponytail: module-level state (one service per process); drop the module once D-P5-20/22 are closed if nothing reads it.

/** Cumulative since the service started. */
export const counters = {
  /** Watcher: changes the reconciliation scan found vs changes a watch callback reported. */
  scanChanges: 0, watchChanges: 0,
  /** Tail adapters: file syncs started, in flight now, failed (the watcher then forgets the file), batches and records. */
  syncsStarted: 0, syncsPending: 0, syncFailures: 0, batches: 0, records: 0,
  /** Writer: committed batches and live deliveries. */
  commits: 0,
  /** Status engine: evidence the store refused (the session stays pinned in memory), out-of-order refolds. */
  statusStoreFailed: 0, refolds: 0, refoldEntries: 0,
  /** Spool replay passes and records delivered by them. */
  replayPasses: 0, replayDelivered: 0,
};

/** Per interval (reset by takePerf): SQL time vs commit-callback time, sum and max. */
const span = { sqlMs: 0, sqlMaxMs: 0, callbackMs: 0, callbackMaxMs: 0 };

export function timed(kind: 'sql' | 'callback', ms: number): void {
  if (kind === 'sql') { span.sqlMs += ms; span.sqlMaxMs = Math.max(span.sqlMaxMs, ms); } else { span.callbackMs += ms; span.callbackMaxMs = Math.max(span.callbackMaxMs, ms); }
}

/** The counters plus this interval's timing; resets the interval sums and maxima only. */
export function takePerf(): typeof counters & typeof span {
  const out = { ...counters, ...span };
  Object.assign(span, { sqlMs: 0, sqlMaxMs: 0, callbackMs: 0, callbackMaxMs: 0 });
  return out;
}
