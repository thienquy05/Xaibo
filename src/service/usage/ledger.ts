// XAIBO-PROD-523 (P5-T17a; design §6.1.1, US-20, FR-52, EC-104): the monthly usage ledger. ledgerPage turns the FR-52
// totals (liveMonthly: frozen + unsettled retained contributions; monthStatus) into one page of at most 12 observed
// months, chronological, with the `end` months of the older and newer pages. Months before the first observation are
// absent; a month empty under the filter is not observed (null values, never a zero); cost is summed in integer micros
// and stays unavailable when nothing was priced; the model filter never applies to quota (filterMonthly). Quota scopes
// leave the service as response-local ordinals, labelled only while the scope is a current one: no opaque key, account
// identity or profile root is sent. MonthlyCache runs the full recompute in a worker thread (this same module started
// with workerData) on its own read-only connection, because liveMonthly and monthStatus rescan retained history
// (P5-T04 review L8); the result is cached until a commit invalidates it, the month changes or it is MAX_AGE_MS old.
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { AGENT_ID, LEDGER_MONTHS, MAX_LEDGER_AGENTS, MAX_LEDGER_MODELS, MAX_LEDGER_QUOTA, MAX_MODEL, MAX_REVISIONS, type LedgerFilter, type LedgerMonth, type LedgerPage, type LedgerQuota, type PortMessage, type PortRequest } from '../../shared/ipc.ts';
import type { LogFields } from '../../shared/log.ts';
import { profileLabel } from '../api.ts';
import { monthStatus, type MonthStatus } from './availability.ts';
import { filterMonthly, liveMonthly, monthOf, scopeKey, type Monthly } from './monthly.ts';

export interface LedgerInput { monthly: Monthly; status: MonthStatus[]; scopeLabels: Record<string, string> }

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function ledgerPage(input: LedgerInput, req: { filter: LedgerFilter; end: string | null; limit: number }): LedgerPage {
  const n = Math.min(Math.max(1, Math.trunc(req.limit) || 1), LEDGER_MONTHS);
  const all = input.status.map((s) => s.month);
  const last = req.end === null ? all.length - 1 : all.findLastIndex((m) => m <= req.end!);
  const first = Math.max(0, last - n + 1);
  const page = last < 0 ? [] : input.status.slice(first, last + 1);
  const older = last >= 0 && first > 0 ? all[first - 1]! : null;
  const newer = last < all.length - 1 ? all[Math.min(last + n, all.length - 1)]! : null;
  const f = filterMonthly(input.monthly, req.filter);
  const months = page.map((s): LedgerMonth => {
    const u = f.usage.filter((x) => x.month === s.month), ss = f.sessions.filter((x) => x.month === s.month);
    const base = { month: s.month, monthToDate: s.monthToDate, detail: s.detail };
    if (!u.length && !ss.length) return { ...base, observed: false, sessions: null, turns: null, tokens: null, cost: null, priceRevisions: [] };
    const tok = { uncachedInput: sum(u.map((x) => x.uncachedInput)), cacheRead: sum(u.map((x) => x.cacheRead)), cacheWrite: sum(u.map((x) => x.cacheWrite)), output: sum(u.map((x) => x.output)) };
    const priced = u.filter((x) => x.costUsd !== null), requests = sum(u.map((x) => x.requests));
    const tokens = { ...tok, total: tok.uncachedInput + tok.cacheRead + tok.cacheWrite + tok.output, gaps: sum(u.map((x) => x.tokenGaps)) };
    return {
      ...base, observed: true, sessions: sum(ss.map((x) => x.sessions)), turns: sum(u.map((x) => x.turns)),
      // review L7: no usage request seen = tokens and cost unavailable (a requested zero stays 0); re-review M: a sum that is
      // not a safe integer (fractional or huge agent-reported counts) is unavailable too, never an unreadable reply
      tokens: requests && Object.values(tokens).every(Number.isSafeInteger) ? tokens : null,
      cost: requests ? { usd: priced.length ? sum(priced.map((x) => Math.round(x.costUsd! * 1e6))) / 1e6 : null, full: sum(u.map((x) => x.costFull)),
        partial: sum(u.map((x) => x.costPartial)), none: sum(u.map((x) => x.costNone)), pending: sum(u.map((x) => x.costPending)) } : null,
      // ponytail: at most MAX_REVISIONS revision ids per month (IPC bound); a month priced under more lists the lowest
      priceRevisions: [...new Set(u.flatMap((x) => x.priceRevisions))].sort((a, b) => a - b).slice(0, MAX_REVISIONS),
    };
  });
  const inPage = new Set(page.map((s) => s.month)), ordinal = new Map<string, number>();
  const quota = f.quota.filter((x) => inPage.has(x.month))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0))
    .map((x): LedgerQuota => {
      if (!ordinal.has(x.scopeKey)) ordinal.set(x.scopeKey, ordinal.size + 1);
      return { month: x.month, scope: ordinal.get(x.scopeKey)!, label: input.scopeLabels[x.scopeKey] ?? null, agent: x.agent || null, limitId: x.limitId,
        windowMinutes: x.windowMinutes, verified: x.verified, peakPercent: x.peakPercent, observations: x.observations };
    }).slice(0, MAX_LEDGER_QUOTA); // ponytail: past the IPC bound (12 months x 256 scopes) the newest months' rows are dropped; unreachable in practice
  // review M2: the IPC bounds applied here; an agent-supplied model id too long to send is not offered as a filter (its usage still counts)
  const m = input.monthly;
  const agents = [...new Set([...m.usage, ...m.sessions, ...m.quota].map((x) => x.agent).filter((a) => AGENT_ID.test(a)))].sort().slice(0, MAX_LEDGER_AGENTS);
  const models = [...new Set(m.usage.map((x) => x.modelId))].filter((x) => x.length <= MAX_MODEL).sort().slice(0, MAX_LEDGER_MODELS);
  return { months, quota, older, newer, agents, models };
}

/** Everything the ledger needs, read in one snapshot (the worker's job). */
function compute(file: string, secret: Buffer, home: string, now: number): LedgerInput {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    db.exec('BEGIN');
    const monthly = liveMonthly(db, secret), status = monthStatus(db, secret, now);
    const scopeLabels: Record<string, string> = {};
    for (const r of db.prepare('SELECT s.scope_key, p.origin, p.root FROM usage_scopes s JOIN profiles p ON p.id = s.profile_id').all() as { scope_key: string; origin: string; root: string }[]) {
      scopeLabels[scopeKey(secret, r.scope_key)] = profileLabel(r.origin, r.root, home);
    }
    db.exec('COMMIT');
    return { monthly, status, scopeLabels };
  } finally { db.close(); }
}

// ponytail: settlement and purge commit without a batch notice; totals are unchanged by design, detail labels may lag this
// long. A request arriving after an invalidate during a run waits for a follow-up run (P5-T16; earlier: review L6).
// Back-to-back commits under live load can mean back-to-back runs (off the service loop); add a minimum interval if a
// core stays busy (review L6/L11).
export const MAX_AGE_MS = 5 * 60_000;
export const TIMEOUT_MS = 60_000; // review M1: a run past this is stopped and the reply says failed

export class MonthlyCache {
  readonly #o: { file: string; secret: Buffer; home: string; now: () => number; maxAgeMs: number; timeoutMs: number; log: (event: string, fields: LogFields) => void };
  #value: { input: LedgerInput; at: number; month: string } | null = null;
  #dirty = true;
  #running: Promise<LedgerInput> | null = null;
  #followUp = false; // #running is a run queued behind an older one (not started yet)
  /** Worker runs started (diagnostics and tests). */
  runs = 0;
  constructor(o: { file: string; secret: Buffer; home: string; now?: () => number; maxAgeMs?: number; timeoutMs?: number; log?: (event: string, fields: LogFields) => void }) {
    this.#o = { now: Date.now, maxAgeMs: MAX_AGE_MS, timeoutMs: TIMEOUT_MS, log: () => undefined, ...o };
  }

  /** A commit changed the store: the next request recomputes. */
  invalidate(): void { this.#dirty = true; this.#value = null; } // review M1: nothing read before it is served again

  get(): Promise<LedgerInput> {
    const now = this.#o.now(), v = this.#value;
    // review L5: a clock that went back (now < at) recomputes too
    if (v && !this.#dirty && now >= v.at && now - v.at < this.#o.maxAgeMs && monthOf(now).month === v.month) return Promise.resolve(v.input);
    // XAIBO-PROD-525 (P5-T16): invalidated since the running worker started (a clear, a commit): wait for it, then run
    // again, so a request after a commit never gets a result read before it. Requests meanwhile share the follow-up run.
    if (this.#running && this.#dirty && !this.#followUp) {
      const after = this.#running.then(() => undefined, () => undefined);
      this.#followUp = true;
      const p: Promise<LedgerInput> = after.then(() => { this.#followUp = false; return this.#run(this.#o.now()); })
        .finally(() => { if (this.#running === p) this.#running = null; });
      this.#running = p;
    }
    if (!this.#running) {
      const p: Promise<LedgerInput> = this.#run(now).finally(() => { if (this.#running === p) this.#running = null; });
      this.#running = p;
    }
    return this.#running;
  }

  #run(now: number): Promise<LedgerInput> {
    this.#dirty = false; // an invalidate during the run marks the result stale again
    this.runs++;
    return new Promise<LedgerInput>((resolve, reject) => {
      let settled = false; // the worker's exit follows its message: only the first outcome counts
      // review L8: a fixed code only (no message text, no path)
      const fail = (code: string) => { if (settled) return; settled = true; clearTimeout(timer); this.#dirty = true; this.#o.log('ledger_worker_failed', { code }); reject(new Error(code)); };
      // review L4: a tight copy (a pooled Buffer would clone its whole backing slab into the worker)
      const w = new Worker(new URL(import.meta.url), { workerData: { xaiboLedger: { file: this.#o.file, secret: new Uint8Array(this.#o.secret), home: this.#o.home, now } } });
      const timer = setTimeout(() => { void w.terminate(); fail('timeout'); }, this.#o.timeoutMs);
      w.once('message', (m: { ok: true; input: LedgerInput } | { ok: false }) => {
        if (!m.ok) return fail('store');
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!this.#dirty) this.#value = { input: m.input, at: now, month: monthOf(now).month }; // review M1: not one invalidated meanwhile
        resolve(m.input);
      });
      w.once('error', () => fail('error'));
      w.once('exit', (c) => fail(`exit-${c}`));
    });
  }
}

/** The port answer; a store that cannot answer says failed (the renderer offers Retry). */
export async function answerMonthly(cache: MonthlyCache, req: PortRequest & { type: 'monthly' }): Promise<PortMessage & { type: 'monthly' }> {
  try {
    return { v: 1, type: 'monthly', id: req.id, ...ledgerPage(await cache.get(), req) };
  } catch {
    return { v: 1, type: 'monthly', id: req.id, months: [], quota: [], older: null, newer: null, agents: [], models: [], failed: true };
  }
}

const job = (workerData as { xaiboLedger?: { file: string; secret: Uint8Array; home: string; now: number } } | null)?.xaiboLedger;
if (!isMainThread && job) {
  try { parentPort!.postMessage({ ok: true, input: compute(job.file, Buffer.from(job.secret), job.home, job.now) }); } catch { parentPort!.postMessage({ ok: false }); }
}
