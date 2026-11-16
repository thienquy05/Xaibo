// P4-T11 live load (EC-57; plan §3.5 M1/M2, PRD §6.6 tiers). Owner decision 2026-11-16: run at the personal profile TP
// now (Gate 4); the same scenario runs plan-scale T2 in the deferred scale-up stage (D-P0-24/26/36, A14).
// Packaged app, XAIBO_PERF_TRACE=1, synthetic profiles only: seeded live sessions (Claude and Codex transcripts; Claude
// hooks through the packaged shim) stream records at the profile rate while the T1 mixed corpus backfills, with one
// session's workspace open; the service is killed at mid-run and restarts. Every event is joined to its paint after the
// run (t2-analysis.ts). Checks: M1 p95 <= 250 ms and M2 p95 <= 1 s outside the restart window, writer queue age
// p95 <= 1 s, drain <= 5 s after load, every record and hook stored exactly once. IDs and timings only leave this process.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { claudeProfile } from '../helpers/hook-socket.ts';
import { close, environment, launch, serviceLog, sleep, stats, type Launched } from './app.ts';
import { emit, installHelpers, now } from './emitter.ts';
import { analyze, type Emitted, type TraceLine } from './t2-analysis.ts';

type Profile = { sessions: number; codexShare: number; rate: number; burstRate: number; burstEverySec: number; burstSec: number; seconds: number };
// TP (PRD §6.6): 5 live sessions at ~20 events/s with bursts to 50/s. T2: 50 live sessions at 200 events/s for 10 min.
export const PROFILES: Record<'TP' | 'T2', Profile> = {
  TP: { sessions: 5, codexShare: 0.4, rate: 20, burstRate: 50, burstEverySec: 60, burstSec: 5, seconds: 600 },
  T2: { sessions: 50, codexShare: 0.4, rate: 200, burstRate: 200, burstEverySec: 0, burstSec: 0, seconds: 600 },
};
const HOOK_SHARE = 0.25; // of a Claude session's events (S12 OQ-A9 mix: 75% file / 25% hook)
const RESTART_SETTLE_MS = 5000; // after the restarted service is ready: spool replay and rescan
const IN_FLIGHT_MS = 1000; // before the kill: events still between emit and paint ack
const B = { m1: 250, m2: 1000, queueAge: 1000, drain: 5000 };
const CWD = '/tmp/xaibo-fixture/perf-live';
const sidOf = (prefix: number, i: number) => `00000000-0000-4000-8000-${String(prefix).padStart(4, '0')}${String(i).padStart(8, '0')}`;

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Declared record sizes: lognormal, median ~1.9 KB, sigma 1.2 (mean ~4 KiB, p99 ~32 KiB), capped at 256 KiB. */
const sizer = (rand: () => number) => () => {
  const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  return Math.min(256 * 1024, Math.max(200, Math.round(1950 * Math.exp(1.2 * z))));
};
const pad = (n: number) => 'synthetic perf text '.repeat(Math.ceil(n / 20)).slice(0, n);
const claudeLine = (sid: string, uuid: string, bytes: number, n: number) => {
  const base = { parentUuid: null, isSidechain: false, uuid, timestamp: new Date().toISOString(), userType: 'external', entrypoint: 'cli', cwd: `${CWD}-${sid}`,
    sessionId: sid, version: '2.1.319' };
  return `${JSON.stringify(n % 2
    ? { ...base, type: 'assistant', message: { model: 'claude-opus-5-5', id: `msg_live_${uuid}`, type: 'message', role: 'assistant',
      content: [{ type: 'text', text: pad(bytes) }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 20, service_tier: 'standard', speed: 'standard' } } }
    : { ...base, type: 'user', message: { role: 'user', content: pad(bytes) } })}\n`;
};
const codexLine = (bytes: number) => `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: pad(bytes) }] } })}\n`;

async function until<T>(f: () => T | null | false | undefined, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (let v = f(); ; v = f()) {
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await sleep(50);
  }
}

export async function liveLoad(tier: 'TP' | 'T2', corpus: string, seed: number, seconds?: number) {
  const p = { ...PROFILES[tier], ...(seconds ? { seconds } : {}) };
  const summary = JSON.parse(readFileSync(path.join(corpus, 'summary.json'), 'utf8')) as { case: string };
  if (summary.case !== 't1mix') throw new Error('needs the mixed corpus: node scripts/gen-perf-corpus.ts --case t1mix');
  const rand = mulberry32(seed);
  const size = sizer(rand);
  const root = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-live-'));
  let l: Launched | undefined;
  let db: DatabaseSync | undefined;
  try {
    const home = path.join(root, 'home');
    // concurrent backfill: the T1 mixed corpus, cloned copy-on-write with its timestamps (as in importProbe, P3-T16d)
    cpSync(path.join(corpus, 'home'), home, { recursive: true, mode: constants.COPYFILE_FICLONE_FORCE, preserveTimestamps: true });
    const claude = path.join(home, '.claude');
    const codex = path.join(home, '.codex');
    const project = path.join(claude, 'projects', '-tmp-xaibo-fixture-perf-live');
    mkdirSync(project, { recursive: true });
    const codexCount = Math.round(p.sessions * p.codexShare);
    const sessions = Array.from({ length: p.sessions }, (_, i) => {
      const sid = sidOf(9, i);
      if (i >= p.sessions - codexCount) {
        const file = path.join(codex, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${sid}.jsonl`);
        mkdirSync(path.dirname(file), { recursive: true });
        const meta = JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: sid, timestamp: new Date().toISOString(),
          cwd: `${CWD}-${sid}`, originator: 'codex-tui', cli_version: '0.160.0', source: 'cli' } });
        writeFileSync(file, `${meta}\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'turn_context', payload: { turn_id: sidOf(10, i), cwd: `${CWD}-${sid}`, model: 'gpt-6.1-sol' } })}\n`);
        return { sid, agent: 'codex' as const, file, identity: createHash('sha256').update(meta).digest('hex').slice(0, 16) };
      }
      const file = path.join(project, `${sid}.jsonl`);
      writeFileSync(file, claudeLine(sid, randomUUID(), 200, 0));
      return { sid, agent: 'claude' as const, file, identity: '' };
    });

    l = await launch(claude, { codex, agy: path.join(home, '.gemini', 'antigravity-cli'), env: { XAIBO_PERF_TRACE: '1' } });
    const launched = l;
    const dataDir = launched.dataDir;
    const profile = await until(() => claudeProfile(dataDir), 30_000);
    await until(() => existsSync(path.join(dataDir, 'run', 'token')), 30_000);
    const shim = installHelpers(dataDir);
    db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
    const reader = db;
    // A spooled hook replayed later gets a newer rowid, so a delivery id is never given to two emits (review M2).
    const deliveryAfter = reader.prepare('SELECT delivery_id AS id FROM hook_delivery WHERE rowid > ? AND native_session_id = ? AND event = ? ORDER BY rowid LIMIT 8');
    const usedDeliveries = new Set<string>();
    const resolve = (top: number, sid: string, event: string) => {
      const id = (deliveryAfter.all(top, sid, event) as { id: string }[]).map((x) => x.id).find((x) => !usedDeliveries.has(x)) ?? null;
      if (id) usedDeliveries.add(id);
      return id;
    };
    const unresolved: { index: number; top: number; sid: string; event: string }[] = [];
    let lateResolved = 0;
    const resolveLate = () => {
      for (const u of unresolved) {
        if (emitted[u.index]!.id !== null) continue;
        const id = resolve(u.top, u.sid, u.event);
        if (id) { emitted[u.index]!.id = id; lateResolved++; }
      }
    };
    const topRow = reader.prepare('SELECT coalesce(max(rowid), 0) AS n FROM hook_delivery');
    const imported = () => serviceLog(dataDir).find((e) => e.event === 'backfill_done');

    const emitted: Emitted[] = [];
    const sizes: number[] = [];
    const fileIds: string[] = [];
    let hooksSent = 0;
    const start = Date.now();
    const loadEndAt = start + p.seconds * 1000;
    const rateAt = (t: number) => (p.burstEverySec && ((t - start) / 1000) % p.burstEverySec < p.burstSec ? p.burstRate : p.rate);
    const pidOf = () => launched.app.evaluate(({ app: a }) => a.getAppMetrics().find((m) => m.name === 'xaibo-service')?.pid ?? null);
    const readies = () => {
      const f = path.join(dataDir, 'logs', 'xaibo.log');
      return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((x) => x.includes('"service_ready"')).length : 0;
    };

    // One serial loop per session at rate/sessions (an agent's events are sequential). Behind schedule it does not
    // sleep, but after a stall (a hook waiting out the shim deadline while the service is down) it catches up by at most
    // one slot, never above the profile rate (review M3).
    let stopped = false; // set when the kill step fails, so no loop writes after cleanup (review M4)
    const run = async (s: (typeof sessions)[number], i: number) => {
      let next = start + (i * 1000) / p.rate;
      let tool = 0;
      for (let n = 1; !stopped && Date.now() < loadEndAt; n++) {
        const interval = (1000 * p.sessions) / rateAt(Date.now());
        next = Math.max(next, Date.now() - interval);
        const wait = next - Date.now();
        if (wait > 0) await sleep(wait);
        next += interval;
        if (s.agent === 'claude' && rand() < HOOK_SHARE) {
          const event = tool % 2 ? 'PostToolUse' : 'PreToolUse';
          const top = Number((topRow.get() as { n: number }).n);
          const e = await emit(shim, 'claude', profile, { hook_event_name: event, session_id: s.sid, cwd: `${CWD}-${s.sid}`, tool_name: 'Bash',
            tool_use_id: `t${Math.floor(tool / 2)}`, tool_input: { command: 'echo 1' }, ...(event === 'PostToolUse' ? { tool_response: { stdout: '1' } } : {}) });
          tool++;
          hooksSent++;
          // none yet: the forwarder gave up at its deadline (the delivery may still land late, or only by the spool replay
          // at the next service start); resolved again after the load, from the same snapshot
          const id = resolve(top, s.sid, event);
          if (id === null) unresolved.push({ index: emitted.length, top, sid: s.sid, event });
          emitted.push({ kind: 'hook', id, t0: e.t0, exit: e.exit });
          continue;
        }
        const bytes = size();
        sizes.push(bytes);
        const id = s.agent === 'claude' ? randomUUID() : `${s.identity}:${statSync(s.file).size}`;
        const line = s.agent === 'claude' ? claudeLine(s.sid, id, bytes, n) : codexLine(bytes);
        const t0 = now();
        appendFileSync(s.file, line);
        fileIds.push(id);
        emitted.push({ kind: 'file', id, t0 });
      }
    };

    // The service kill at mid-run; the window ends RESTART_SETTLE_MS after the restarted service is ready.
    let restart: { from: bigint; to: bigint } | null = null;
    const kill = async () => {
      await sleep((p.seconds * 1000) / 2);
      const pid = await pidOf();
      if (!pid) return;
      const before = readies();
      // An event committed in the dying service's last delta window (50 ms) loses its delta and paint ack (it is stored,
      // and shows after the restart's cursor resync), so the window opens IN_FLIGHT_MS before the kill.
      const from = now() - BigInt(IN_FLIGHT_MS * 1e6);
      process.kill(pid, 'SIGKILL');
      await until(() => readies() > before, 60_000);
      restart = { from, to: now() + BigInt(RESTART_SETTLE_MS * 1e6) };
    };

    // One session's workspace open in the Session area while the load runs (best effort: reported, not a check).
    await sleep(2000);
    const workspaceOpen = await launched.page.getByText(`${CWD}-${sessions[0]!.sid}`).first().click({ timeout: 10_000 }).then(() => true, () => false);

    const settled = await Promise.allSettled([...sessions.map(run), kill().catch((e: unknown) => { stopped = true; throw e; })]);
    const failed = settled.find((x) => x.status === 'rejected');
    if (failed) throw failed.reason; // every loop has stopped: cleanup below never races a writer
    // The end of load is the last emit, not the end of a slow restart (review M5).
    const loadEnd = emitted.reduce((m, e) => (e.t0 > m ? e.t0 : m), 0n);
    const backfillDone = imported();

    // Drain: wait until every event is painted (or 30 s), then judge drain from the trace.
    const traceFile = (f: string) => readFileSync(path.join(dataDir, 'logs', f), 'utf8').split('\n').filter((x) => x.endsWith('}')).map((x) => JSON.parse(x) as TraceLine);
    const result = () => analyze({ emitted, service: traceFile('perf-trace-service.jsonl'), main: traceFile('perf-trace-main.jsonl'), restart, loadEnd });
    resolveLate();
    let r = result();
    for (const end = Date.now() + 30_000; r.unpainted.steady + r.unpainted.restart > 0 && Date.now() < end;) { await sleep(1000); resolveLate(); r = result(); }
    // Spooled hooks reach the store by replay: the stored-once counts get the same 30 s.
    const storedOnce = () => {
      const files = reader.prepare('SELECT count(*) AS rows, count(DISTINCT native_id) AS ids FROM events WHERE native_id IN (SELECT value FROM json_each(?))').get(JSON.stringify(fileIds)) as { rows: number; ids: number };
      const hooks = Number((reader.prepare('SELECT count(*) AS n FROM hook_delivery WHERE native_session_id IN (SELECT value FROM json_each(?))').get(JSON.stringify(sessions.map((s) => s.sid))) as { n: number }).n);
      return { records: { sent: fileIds.length, rows: Number(files.rows), ids: Number(files.ids) }, hooks: { sent: hooksSent, rows: hooks } };
    };
    let stored = storedOnce();
    for (const end = Date.now() + 30_000; (stored.records.ids < stored.records.sent || stored.hooks.rows < stored.hooks.sent) && Date.now() < end;) { await sleep(1000); stored = storedOnce(); }

    const w = restart as { from: bigint; to: bigint } | null;
    const checks = {
      m1: r.m1.steady.p95 <= B.m1 && r.m1.steady.n >= 100,
      m2: r.m2.steady.p95 <= B.m2 && r.m2.steady.n >= 100,
      queueAge: r.ingestLagMs.n > 0 && r.ingestLagMs.p95 <= B.queueAge, // emit -> commit; the writer's own queue is ~0 by design
      drain: r.drainMs <= B.drain,
      recordsOnce: stored.records.rows === stored.records.sent && stored.records.ids === stored.records.sent,
      hooksOnce: stored.hooks.rows === stored.hooks.sent,
      restarted: w !== null,
      // review M1: the load ran while the T1 corpus was still importing, with one session's workspace open
      backfillDuringLoad: backfillDone !== undefined && Date.parse(backfillDone.t) > start,
      workspaceOpen,
    };
    const sorted = [...sizes].sort((a, b) => a - b);
    return {
      metric: 'live-load', profile: tier, profileSpec: p, seed, budgetsMs: B,
      load: { events: emitted.length, hooks: hooksSent, records: fileIds.length, eventsPerSecond: Math.round(emitted.length / p.seconds), seconds: p.seconds },
      recordBytes: { ...stats(sizes), p99: sorted[Math.max(0, Math.ceil(0.99 * sorted.length) - 1)] ?? null },
      m1: r.m1, m2: r.m2, m1Hops: r.hops.m1, unpainted: r.unpainted, steadyMisses: r.steadyMisses,
      // seconds late = delivered live after the forwarder gave up; minutes = only by the spool replay at the restart
      hooksPastForwarderDeadline: { count: unresolved.length, resolvedAfterLoad: lateResolved,
        emitToPaintMs: analyze({ emitted: unresolved.map((u) => emitted[u.index]!), service: traceFile('perf-trace-service.jsonl'), main: traceFile('perf-trace-main.jsonl'), restart: null, loadEnd }).m1.steady },
      killAtMs: w ? Math.round(Number(w.from - (emitted[0]?.t0 ?? w.from)) / 1e6) + IN_FLIGHT_MS : null, drainMs: r.drainMs, ingestLagMs: r.ingestLagMs, writerQueueAgeMs: r.queueAgeMs, deltaResyncs: r.deltaResyncs,
      restart: w ? { windowMs: Number(w.to - w.from) / 1e6 } : null,
      stored, backfill: { corpus: summary.case, doneMs: backfillDone ? Date.parse(backfillDone.t) - launched.created : null }, workspaceOpen,
      notes: 'M1/M2 checks use events emitted outside the restart window (kill to restarted-ready + 5 s); restart-window samples are reported apart. '
        + 'A miss (never painted, or a hook spooled at the deadline) is timed as Infinity, which JSON prints as null. Queue age is checked as ingest lag '
        + '(emit -> commit, steady events): file syncs flush the writer right after they enqueue, so the writer\'s own 5 s queue-age peaks stay ~0. Drain counts steady events. '
        + 'Paint ack = flushSync + 2 rAF, an upper bound.',
      checks, pass: Object.values(checks).every(Boolean), env: await environment(launched.app),
    };
  } finally {
    db?.close();
    if (l) await close(l);
    rmSync(root, { recursive: true, force: true });
  }
}
