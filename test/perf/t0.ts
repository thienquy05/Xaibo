// T0 perf probes (P3-T11 notify; the rest of the tier is P3-T16). notify (EC-59, US-2): hook emission to OS notification
// dispatch on the packaged app, real monotonic clock on both ends (the emitter's and main's process.hrtime), stub mode
// (XAIBO_NOTIFY_STUB=1). One session, 100 sequential permission requests, each resolved before the next.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { emit, installHelpers, ms, now, Trace } from './emitter.ts';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeProfile, deliver } from '../helpers/hook-socket.ts';
import { close, environment, launch, query, serviceLog, sleep, stats } from './app.ts';
import type { Launched } from './app.ts';

const EVENTS = 100;
const BUDGET_MS = 2000;
const SID = '00000000-0000-4000-8000-0000000f1112';

async function until<T>(f: () => T | null | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (let v = f(); ; v = f()) {
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await sleep(10);
  }
}

export async function notifyProbe() {
  const claude = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-claude-'));
  mkdirSync(path.join(claude, 'projects'));
  const l = await launch(claude, { env: { XAIBO_NOTIFY_STUB: '1' } });
  try {
    const profile = await until(() => claudeProfile(l.dataDir), 30_000);
    await until(() => existsSync(path.join(l.dataDir, 'run', 'token')), 30_000);
    const stub = path.join(l.dataDir, 'logs', 'notify-stub.jsonl');
    const lines = () => (existsSync(stub) ? readFileSync(stub, 'utf8').trim().split('\n').filter(Boolean) : []);
    const hook = (event: string, payload: Record<string, unknown> = {}) => deliver(l.dataDir, { v: 1, delivery_id: randomUUID(), agent: 'claude',
      profile_key: profile, event, session_id: SID, cwd: '/tmp/xaibo-fixture/perf', received_ts: Date.now(), payload: { hook_event_name: event, session_id: SID, ...payload } });
    await hook('SessionStart', { source: 'startup' });
    await hook('UserPromptSubmit', { prompt: 'p' });
    const ms: number[] = [];
    for (let i = 0; i < EVENTS; i++) {
      await hook('PreToolUse', { tool_name: 'Write', tool_use_id: `t${i}` });
      const t0 = process.hrtime.bigint();
      await hook('PermissionRequest', { tool_name: 'Write' });
      const line = await until(() => lines()[i], 10_000);
      ms.push(Number(BigInt((JSON.parse(line) as { t: string }).t) - t0) / 1e6);
      await hook('PostToolUse', { tool_name: 'Write', tool_use_id: `t${i}` });
    }
    const s = stats(ms);
    const extra = lines().length - EVENTS;
    return { metric: 'notify', events: EVENTS, emitToDispatchMs: s, extraNotifications: extra, budgetMs: BUDGET_MS, pass: s.p95 <= BUDGET_MS && extra === 0,
      env: await environment(l.app) };
  } finally {
    await close(l);
    rmSync(claude, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// P3-T16a live probes (plan §3.5; D-P3-18), packaged app, XAIBO_PERF_TRACE=1, synthetic profiles only.
// M1: hook -> paint p95 <= 250 ms over >= 500 mixed events through the packaged shim and forwarder; "Finishing…"
//     (the Stop paint) <= 250 ms; settled <= settle interval (4 s) + 250 ms.
// M11: SessionStart hook -> identified row painted, and a new transcript's first record -> painted, p95 <= 300 ms.
// M2: complete JSONL record appended -> painted, p95 <= 1 s per path (plain, Claude usage + priced turn, compaction,
//     Codex token_count with rate limits); missed-watch recovery (a file older than the active window, so only the
//     5 s scan sees it) <= interval + 1 s. Hops: dispatch (shim + forwarder until exit), commit, delta, paint.
const CYCLES = 25; // x 24 events = 600 hook events
const SAMPLES = 20;
const RECOVERY = 5;
const SETTLE_MS = 4000;
const B = { m1: 250, finishing: 250, settled: SETTLE_MS + 250, m11: 300, m2: 1000, recovery: 5000 + 1000 };
const PROJECT = '-tmp-xaibo-fixture-perf';
const CWD = '/tmp/xaibo-fixture/perf';
const sidOf = (prefix: number, i: number) => `00000000-0000-4000-8000-${String(prefix).padStart(4, '0')}${String(i).padStart(8, '0')}`;
const claudeLine = (sid: string, uuid: string, o: object) => `${JSON.stringify({ parentUuid: null, isSidechain: false, uuid, timestamp: new Date().toISOString(),
  userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId: sid, version: '2.1.319', ...o })}\n`;
const user = (sid: string, uuid: string) => claudeLine(sid, uuid, { type: 'user', message: { role: 'user', content: 'synthetic prompt' } });
const assistant = (sid: string, uuid: string, n: number) => claudeLine(sid, uuid, { type: 'assistant', message: { model: 'claude-opus-5-5', id: `msg_perf_${n}`,
  type: 'message', role: 'assistant', content: [{ type: 'text', text: 'synthetic reply' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 20, service_tier: 'standard', speed: 'standard' } } });
const compaction = (sid: string, uuid: string) => claudeLine(sid, uuid, { type: 'system', subtype: 'compact_boundary', content: 'synthetic compaction',
  isMeta: false, level: 'info', compactMetadata: { trigger: 'manual', preTokens: 1200 } });

/** In-page wait for the row with this cwd to show `text` in its status cell; wall-clock ms when seen. */
const rowShows = (page: Page, cwd: string, text: string, timeout: number) => page.evaluate(async ({ cwd, text, timeout }) => {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    const row = [...document.querySelectorAll('tr')].find((r) => r.querySelectorAll('td')[2]?.textContent === cwd);
    if (row?.querySelectorAll('td')[7]?.textContent?.includes(text)) return performance.timeOrigin + performance.now();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return null;
}, { cwd, text, timeout });

export async function liveProbe() {
  const claude = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-claude-'));
  const codex = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-codex-'));
  const project = path.join(claude, 'projects', PROJECT);
  mkdirSync(project, { recursive: true });
  const active = sidOf(1, 0);
  const activeFile = path.join(project, `${active}.jsonl`);
  writeFileSync(activeFile, user(active, randomUUID()));
  const stale = Array.from({ length: RECOVERY }, (_, i) => { // older than the 10 min active window: no fs.watch, scan only
    const sid = sidOf(2, i);
    const f = path.join(project, `${sid}.jsonl`);
    writeFileSync(f, user(sid, randomUUID()));
    const old = new Date(Date.now() - 3600_000);
    utimesSync(f, old, old);
    return { sid, f };
  });
  const csid = sidOf(3, 0);
  const rollout = path.join(codex, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${csid}.jsonl`);
  mkdirSync(path.dirname(rollout), { recursive: true });
  const meta = JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: csid, timestamp: new Date().toISOString(),
    cwd: '/tmp/xaibo-fixture/perf-codex', originator: 'codex-tui', cli_version: '0.160.0', source: 'cli' } });
  writeFileSync(rollout, `${meta}\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'turn_context', payload: { turn_id: sidOf(3, 1), cwd: '/tmp/xaibo-fixture/perf-codex', model: 'gpt-6.1-sol' } })}\n`);
  const codexIdentity = createHash('sha256').update(meta).digest('hex').slice(0, 16);

  const l = await launch(claude, { codex, env: { XAIBO_PERF_TRACE: '1' } });
  try {
    const profile = await until(() => claudeProfile(l.dataDir), 30_000);
    await until(() => existsSync(path.join(l.dataDir, 'run', 'token')), 30_000);
    const shim = installHelpers(l.dataDir);
    const trace = new Trace(l.dataDir);
    await sleep(3000); // backfill of the seeded files settles

    // M1 + M11 (hook): sequential cycles of a realistic turn, each event joined to its own paint.
    type Hop = { total: number; dispatch: number; commit: number; delta: number; paint: number };
    const m1: Hop[] = [];
    const finishing: number[] = [];
    const settled: number[] = [];
    const settledAfterFinishing: number[] = [];
    const m11Hook: number[] = [];
    const ids = new Set<string>();
    const hook = async (sid: string, cwd: string, event: string, extra: object = {}) => {
      const e = await emit(shim, 'claude', profile, { hook_event_name: event, session_id: sid, cwd, ...extra });
      const j = await trace.join(null, 10_000, e.t0);
      if (ids.has(j.id)) throw new Error('a commit was matched twice'); // review M2: one emit, one commit
      ids.add(j.id);
      const hop = { total: ms(e.t0, j.paint), dispatch: ms(e.t0, e.exit), commit: ms(e.t0, j.commit), delta: ms(j.commit, j.delta), paint: ms(j.delta, j.paint) };
      m1.push(hop);
      return hop;
    };
    for (let c = 0; c < CYCLES; c++) {
      const sid = sidOf(4, c);
      const cwd = `${CWD}-m1-${c}`;
      m11Hook.push((await hook(sid, cwd, 'SessionStart', { source: 'startup' })).total);
      await hook(sid, cwd, 'UserPromptSubmit', { prompt: 'synthetic prompt' });
      for (let i = 0; i < 9; i++) {
        await hook(sid, cwd, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: `echo ${i}` }, tool_use_id: `b${i}` });
        await hook(sid, cwd, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `echo ${i}` }, tool_use_id: `b${i}`, tool_response: { stdout: `${i}` } });
      }
      await hook(sid, cwd, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: `${cwd}/a` }, tool_use_id: 'w' });
      await hook(sid, cwd, 'PermissionRequest', { tool_name: 'Write' });
      await hook(sid, cwd, 'PostToolUse', { tool_name: 'Write', tool_use_id: 'w', tool_response: { ok: true } });
      // review M1: settle on the wall clock (the page's), from the Stop emit and from the Stop paint ("Finishing…")
      const stopWall = Date.now();
      finishing.push((await hook(sid, cwd, 'Stop')).total);
      const finishedWall = Date.now();
      const idle = await rowShows(l.page, cwd, 'Idle', SETTLE_MS + 5000);
      settled.push(idle === null ? Number.POSITIVE_INFINITY : idle - stopWall);
      settledAfterFinishing.push(idle === null ? Number.POSITIVE_INFINITY : idle - finishedWall);
    }

    // M2: file appends with no hooks for these sessions, each joined by its record id.
    const append = async (file: string, text: string, id: string) => {
      const t0 = now();
      appendFileSync(file, text);
      const j = await trace.join(id, 15_000, t0);
      return ms(t0, j.paint);
    };
    const m2: Record<string, number[]> = { plain: [], usagePriced: [], compaction: [], codexTokenCount: [] };
    for (let i = 0; i < SAMPLES; i++) {
      let id = randomUUID();
      m2.plain!.push(await append(activeFile, user(active, id), id));
      id = randomUUID();
      m2.usagePriced!.push(await append(activeFile, assistant(active, id, i), id));
      id = randomUUID();
      m2.compaction!.push(await append(activeFile, compaction(active, id), id));
      const offset = statSync(rollout).size;
      const total = { input_tokens: 100 * (i + 1), cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20 * (i + 1), reasoning_output_tokens: 0, total_tokens: 120 * (i + 1) };
      const tc = JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count',
        info: { total_token_usage: total, last_token_usage: { ...total, input_tokens: 100, output_tokens: 20, total_tokens: 120 }, model_context_window: 200000 },
        rate_limits: { limit_id: 'codex', primary: { used_percent: i, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 } } } });
      m2.codexTokenCount!.push(await append(rollout, `${tc}\n`, `${codexIdentity}:${offset}`));
    }
    const priced = await l.page.evaluate((cwd) => [...document.querySelectorAll('tr')].find((r) => r.querySelectorAll('td')[2]?.textContent === cwd)?.textContent?.includes('~$') ?? false, CWD);
    const recovery: number[] = [];
    for (const s of stale) { const id = randomUUID(); recovery.push(await append(s.f, user(s.sid, id), id)); }

    // M11 (file only): a new transcript's first record.
    const m11File: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const sid = sidOf(5, i);
      const id = randomUUID();
      m11File.push(await append(path.join(project, `${sid}.jsonl`), user(sid, id), id));
    }

    const hop = (k: keyof Hop) => stats(m1.map((h) => h[k]));
    const m2Stats = Object.fromEntries(Object.entries(m2).map(([k, v]) => [k, stats(v)]));
    const checks = {
      m1: hop('total').p95 <= B.m1 && m1.length >= 500, finishing: stats(finishing).p95 <= B.finishing, settled: stats(settled).p95 <= B.settled, // §3.5 M1 row is p95; max reported
      m11Hook: stats(m11Hook).p95 <= B.m11, m11File: stats(m11File).p95 <= B.m11,
      m2: Object.values(m2Stats).every((s) => s.p95 <= B.m2), priced, recovery: stats(recovery).p95 <= B.recovery,
    };
    return {
      metric: 'live', budgetsMs: B, events: m1.length,
      m1: { total: hop('total'), dispatch: hop('dispatch'), toCommit: hop('commit'), commitToDelta: hop('delta'), deltaToPaint: hop('paint') },
      finishing: stats(finishing), settled: { fromStopEmit: stats(settled), fromFinishingPaint: stats(settledAfterFinishing), clock: 'wall' },
      m11: { hook: stats(m11Hook), file: stats(m11File) }, m2: m2Stats, pricedRowShowsEstimate: priced, recovery: { ...stats(recovery), note: `max of ${RECOVERY}` },
      notes: 'M1 is the unloaded serial figure (one event at a time, no burst); M1/M2 during import are T16d. Paint ack = flushSync + 2 rAF, an upper bound.',
      checks, pass: Object.values(checks).every(Boolean), env: await environment(l.app),
    };
  } finally {
    await close(l);
    rmSync(claude, { recursive: true, force: true });
    rmSync(codex, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// P3-T16d (plan §3.5 M3 "M1/M2 hold during import"): M1 hook -> paint and M2 append -> paint per path while the mixed
// T1 corpus imports. The corpus is cloned copy-on-write (APFS clonefile: no extra space, the original is never written)
// and the probe's live files are added to the clone. During an import, file-record commits also carry trace ids, so
// each hook is joined by its own delivery id, read from hook_delivery after the forwarder exits. A sample counts as
// during the import when it completes before the service's backfill_done.
export async function importProbe(corpus: string) {
  const summary = JSON.parse(readFileSync(path.join(corpus, 'summary.json'), 'utf8')) as { case: string };
  if (summary.case !== 't1mix') throw new Error('needs the mixed corpus: node scripts/gen-perf-corpus.ts --case t1mix');
  const root = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-import-'));
  let l: Launched | undefined;
  try { // review M1: a failed clone or launch still removes root
    const home = path.join(root, 'home');
    // fails rather than copy ~700 MB; timestamps kept, or every corpus file would look active (P3-T16e: the 200-watch cap
    // then left the probe's own live files to the 5 s scan)
    cpSync(path.join(corpus, 'home'), home, { recursive: true, mode: constants.COPYFILE_FICLONE_FORCE, preserveTimestamps: true });
    const claude = path.join(home, '.claude');
    const codex = path.join(home, '.codex');
    const project = path.join(claude, 'projects', `${PROJECT}-import`);
    mkdirSync(project, { recursive: true });
    const active = sidOf(6, 0);
    const activeFile = path.join(project, `${active}.jsonl`);
    writeFileSync(activeFile, user(active, randomUUID()));
    const csid = sidOf(7, 0);
    const rollout = path.join(codex, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${csid}.jsonl`);
    mkdirSync(path.dirname(rollout), { recursive: true });
    const meta = JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: csid, timestamp: new Date().toISOString(),
      cwd: '/tmp/xaibo-fixture/perf-import-codex', originator: 'codex-tui', cli_version: '0.160.0', source: 'cli' } });
    writeFileSync(rollout, `${meta}\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'turn_context', payload: { turn_id: sidOf(7, 1), cwd: '/tmp/xaibo-fixture/perf-import-codex', model: 'gpt-6.1-sol' } })}\n`);
    const codexIdentity = createHash('sha256').update(meta).digest('hex').slice(0, 16);

    l = await launch(claude, { codex, agy: path.join(home, '.gemini', 'antigravity-cli'), env: { XAIBO_PERF_TRACE: '1' } });
    const dataDir = l.dataDir;
    const profile = await until(() => claudeProfile(dataDir), 30_000);
    await until(() => existsSync(path.join(dataDir, 'run', 'token')), 30_000);
    const shim = installHelpers(dataDir);
    const trace = new Trace(dataDir);
    const imported = () => serviceLog(dataDir).find((e) => e.event === 'backfill_done');
    const m1: { total: number; dispatch: number }[] = [];
    const m2: Record<string, number[]> = { plain: [], usagePriced: [], compaction: [], codexTokenCount: [] };
    let spooledHooks = 0;
    const misses = { m1: 0, m2: 0 }; // during-import samples not painted within 15 s, timed as Infinity (JSON shows null)
    const hook = async (sid: string, cwd: string, event: string, extra: object = {}) => {
      const during = !imported(); // review M2: membership by start time, the same rule for successes and misses
      const top = Number(query<number>(dataDir, 'SELECT coalesce(max(rowid), 0) FROM hook_delivery'));
      const e = await emit(shim, 'claude', profile, { hook_event_name: event, session_id: sid, cwd, ...extra });
      // review M3: this hook's own row (after the snapshot, same session and event); none = spooled at the deadline
      const id = query<string | undefined>(dataDir, 'SELECT delivery_id FROM hook_delivery WHERE rowid > ? AND native_session_id = ? AND event = ? ORDER BY rowid LIMIT 1', top, sid, event);
      if (!id) { spooledHooks++; return; }
      const j = await trace.join(id, 15_000, e.t0).catch(() => null);
      if (!during) return;
      if (!j) misses.m1++;
      m1.push({ total: j ? ms(e.t0, j.paint) : Number.POSITIVE_INFINITY, dispatch: ms(e.t0, e.exit) });
    };
    const append = async (key: string, file: string, text: string, id: string) => {
      const during = !imported();
      const t0 = now();
      appendFileSync(file, text);
      const j = await trace.join(id, 15_000, t0).catch(() => null);
      if (!during) return;
      if (!j) misses.m2++;
      m2[key]!.push(j ? ms(t0, j.paint) : Number.POSITIVE_INFINITY);
    };
    const deadline = Date.now() + 30 * 60_000; // review M4: backfill_done may never come
    // Two independent serial streams, as an agent produces hooks while its transcript grows: a slow M2 sample must not
    // starve M1 of samples.
    const overdue = () => { if (Date.now() > deadline) throw new Error('import did not finish within 30 min'); };
    const hooks = async () => {
      for (let c = 0; !imported(); c++) {
        overdue();
        const sid = sidOf(8, c);
        const cwd = `${CWD}-import-${c}`;
        for (const [event, extra] of [['SessionStart', { source: 'startup' }], ['UserPromptSubmit', { prompt: 'synthetic prompt' }],
          ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo 1' }, tool_use_id: 'b' }], ['PostToolUse', { tool_name: 'Bash', tool_use_id: 'b', tool_response: { stdout: '1' } }],
          ['Stop', {}]] as [string, object][]) {
          if (imported()) break;
          await hook(sid, cwd, event, extra);
        }
      }
    };
    const appends = async () => {
      for (let c = 0; !imported(); c++) {
        overdue();
        const k = Object.keys(m2)[c % 4]!;
        if (k === 'codexTokenCount') {
          const offset = statSync(rollout).size;
          const total = { input_tokens: 100 * (c + 1), cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20 * (c + 1), reasoning_output_tokens: 0, total_tokens: 120 * (c + 1) };
          const tc = JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count',
            info: { total_token_usage: total, last_token_usage: { ...total, input_tokens: 100, output_tokens: 20, total_tokens: 120 }, model_context_window: 200000 },
            rate_limits: { limit_id: 'codex', primary: { used_percent: c % 100, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 } } } });
          await append(k, rollout, `${tc}\n`, `${codexIdentity}:${offset}`);
        } else {
          const id = randomUUID();
          await append(k, activeFile, k === 'plain' ? user(active, id) : k === 'usagePriced' ? assistant(active, id, c) : compaction(active, id), id);
        }
      }
    };
    await Promise.all([hooks(), appends()]);
    const importMs = Date.parse(imported()!.t) - l.created; // includes the probe's own load
    const total = stats(m1.map((x) => x.total));
    // a hook spooled at the deadline reaches the UI only by replay: counted as a miss (Infinity) in the gate figure
    const withSpooled = stats([...m1.map((x) => x.total), ...Array<number>(spooledHooks).fill(Number.POSITIVE_INFINITY)]);
    const m2Stats = Object.fromEntries(Object.entries(m2).map(([k, v]) => [k, stats(v)]));
    const checks = { m1: withSpooled.p95 <= B.m1 && m1.length >= 50, m2: Object.values(m2Stats).every((s) => s.n >= 5 && s.p95 <= B.m2) };
    return { metric: 'live-during-import', corpus: summary.case, budgetsMs: { m1: B.m1, m2: B.m2 }, importToBackfillDoneMs: importMs,
      m1: { total, totalWithSpooledAsMisses: withSpooled, dispatch: stats(m1.map((x) => x.dispatch)) }, m2: m2Stats, spooledHooks, misses,
      notes: 'Samples started before backfill_done; M1 serial, one event at a time, shim + forwarder included; hooks that spooled at the deadline are counted, and timed as misses in totalWithSpooledAsMisses (the checked figure); '
        + 'a miss (no paint within 15 s) is timed as Infinity, which JSON prints as null. M2 per path n is small (about n/4 of the cycles).',
      checks, pass: Object.values(checks).every(Boolean), env: await environment(l.app) };
  } finally {
    if (l) await close(l);
    rmSync(root, { recursive: true, force: true });
  }
}
