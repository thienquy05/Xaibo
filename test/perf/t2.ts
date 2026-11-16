// P4-T11 live load (EC-57; plan §3.5 M1/M2, PRD §6.6 tiers). Owner decision 2026-11-16: run at the personal profile TP
// now (Gate 4); the same scenario runs plan-scale T2 in the deferred scale-up stage (D-P0-24/26/36, A14).
// Packaged app, XAIBO_PERF_TRACE=1, synthetic profiles only: seeded live sessions (Claude and Codex transcripts; Claude
// hooks through the packaged shim) stream records at the profile rate while the T1 mixed corpus backfills, with one
// session's workspace open; the service is killed at mid-run and restarts. Every event is joined to its paint after the
// run (t2-analysis.ts). Checks: M1 p95 <= 250 ms and M2 p95 <= 1 s outside the restart window, writer queue age
// p95 <= 1 s, drain <= 5 s after load, every record and hook stored exactly once. IDs and timings only leave this process.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { claudeProfile } from '../helpers/hook-socket.ts';
import { close, environment, launch, serviceLog, sleep, stats, tornLogLines, type Launched } from './app.ts';
import { emit, installHelpers, now } from './emitter.ts';
import { analyze, type Emitted, type TraceLine, type Window } from './t2-analysis.ts';
import { footprintMiB, psTree } from './m16.ts';
import { codexTokenCount, fillVolume, FRAME_MS, frame, installTee, MALFORMED_EVERY, malformed, ORIGINAL, sh, timed, volume, type Timed } from './t2-usage.ts';

type Profile = { sessions: number; codexShare: number; rate: number; burstRate: number; burstEverySec: number; burstSec: number; seconds: number };
// TP (PRD §6.6): 5 live sessions at ~20 events/s with bursts to 50/s. T2: 50 live sessions at 200 events/s for 10 min.
export const PROFILES: Record<'TP' | 'T2', Profile> = {
  TP: { sessions: 5, codexShare: 0.4, rate: 20, burstRate: 50, burstEverySec: 60, burstSec: 5, seconds: 600 },
  T2: { sessions: 50, codexShare: 0.4, rate: 200, burstRate: 200, burstEverySec: 0, burstSec: 0, seconds: 600 },
};
const HOOK_SHARE = 0.25; // of a Claude session's events (S12 OQ-A9 mix: 75% file / 25% hook)
const RESTART_SETTLE_MS = 5000; // after the restarted service is ready: spool replay and rescan
const IN_FLIGHT_MS = 1000; // before the kill: events still between emit and paint ack
const B = { m1: 250, m2: 1000, queueAge: 1000, drain: 5000, m16: 100, m5MB: 450 };
// P4-T12b (--usage): the disk fills at a quarter of the run (the kill stays at half) and stays full this long.
const FULL_HOLD_MS = 20_000;
const VOLUME_GIB = 4; // the data dir's sparse image: room for the t1mix import and the live stream
const TOKEN_EVERY = 5; // a Codex session's every 5th record is a token_count, every 50th of those malformed
const PROHIBITED = /(^|\s)(-p|--print|exec)(\s|$)|\/context|count_tokens/; // FR-44, as the P4-T12a runtime audit
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

/** usage: P4-T12b frames and checks; diskFull (with usage): the data dir on its own volume, filled once (off: the
 *  attribution run that tells the volume's write cost from the usage work). */
export async function liveLoad(tier: 'TP' | 'T2', corpus: string, seed: number, seconds?: number, usage = false, withDiskFull = true) {
  const p = { ...PROFILES[tier], ...(seconds ? { seconds } : {}) };
  // review M7: the fault (quarter mark, fill, 20 s hold, <= 15 s clear, 5 s settle) must end before the kill at half
  if (usage && withDiskFull && p.seconds < 240) throw new Error('--usage with the disk-full fault needs --seconds >= 240 (or --no-disk-full)');
  const summary = JSON.parse(readFileSync(path.join(corpus, 'summary.json'), 'utf8')) as { case: string };
  if (summary.case !== 't1mix') throw new Error('needs the mixed corpus: node scripts/gen-perf-corpus.ts --case t1mix');
  const rand = mulberry32(seed);
  const size = sizer(rand);
  const root = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-live-'));
  let l: Launched | undefined;
  let db: DatabaseSync | undefined;
  let vol: ReturnType<typeof volume> | undefined;
  // review M6: Ctrl-C must not leave the image mounted (up to 4 GiB of host disk)
  const onSigint = () => { try { vol?.detach(); } finally { rmSync(root, { recursive: true, force: true }); process.exit(130); } };
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

    // --usage: the data dir on its own volume, so the disk-full fault fills the store's disk and nothing else
    let ownDataDir: string | undefined;
    if (usage && withDiskFull) { vol = volume(root, VOLUME_GIB); process.once('SIGINT', onSigint); ownDataDir = path.join(vol.mount, 'data'); mkdirSync(ownDataDir, { mode: 0o700 }); }
    l = await launch(claude, { codex, agy: path.join(home, '.gemini', 'antigravity-cli'), env: { XAIBO_PERF_TRACE: '1' }, ...(ownDataDir ? { dataDir: ownDataDir } : {}) });
    const launched = l;
    const dataDir = launched.dataDir;
    // P4-T12b: renderer health, so a window that stops painting says why (main logs no renderer crash or hang)
    const renderer = { pageCrashed: null as number | null, pageClosed: null as number | null };
    launched.page.on('crash', () => { renderer.pageCrashed ??= Date.now() - launched.created; });
    launched.page.on('close', () => { renderer.pageClosed ??= Date.now() - launched.created; });
    await launched.app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { xaiboPerfRenderer?: string[] };
      g.xaiboPerfRenderer = [];
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.on('render-process-gone', (_e, d) => { g.xaiboPerfRenderer!.push(`gone:${d.reason}:${Date.now()}`); });
        w.on('unresponsive', () => { g.xaiboPerfRenderer!.push(`unresponsive:${Date.now()}`); });
        w.on('responsive', () => { g.xaiboPerfRenderer!.push(`responsive:${Date.now()}`); });
      }
    });
    const rendererEvents = () => Promise.race([
      launched.app.evaluate(() => (globalThis as unknown as { xaiboPerfRenderer?: string[] }).xaiboPerfRenderer ?? []),
      sleep(5000).then(() => ['main-unreachable']),
    ]).catch(() => ['main-unreachable']);
    const profile = await until(() => claudeProfile(dataDir), 30_000);
    await until(() => existsSync(path.join(dataDir, 'run', 'token')), 30_000);
    const shim = installHelpers(dataDir);
    const teeCmd = usage ? installTee(dataDir, profile) : null;
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
    const hookBaseline: { t0: bigint; ms: number }[] = [];
    const tokenLines = { valid: 0, malformed: 0 };
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
      let tokens = 0;
      for (let n = 1; !stopped && Date.now() < loadEndAt; n++) {
        const interval = (1000 * p.sessions) / rateAt(Date.now());
        next = Math.max(next, Date.now() - interval);
        const wait = next - Date.now();
        if (wait > 0) await sleep(wait);
        next += interval;
        if (s.agent === 'claude' && rand() < HOOK_SHARE) {
          const event = tool % 2 ? 'PostToolUse' : 'PreToolUse';
          const top = Number((topRow.get() as { n: number }).n);
          if (usage && hooksSent % 4 === 0) { const b = await timed('/usr/bin/true', [], '{}'); hookBaseline.push({ t0: b.t0, ms: b.ms }); } // M16 under load: spawn alone
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
        if (usage && s.agent === 'codex' && n % TOKEN_EVERY === 0) {
          const k = n / TOKEN_EVERY;
          const bad = k % 50 === 0;
          tokens += 120;
          const id = `${s.identity}:${statSync(s.file).size}`;
          const t0 = now();
          appendFileSync(s.file, codexTokenCount(tokens, k, bad));
          fileIds.push(id);
          emitted.push({ kind: 'file', id, t0 });
          tokenLines[bad ? 'malformed' : 'valid']++;
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

    // --usage: one statusLine frame per Claude session every FRAME_MS through the packaged tee, each paired with the
    // original alone on the same stdin (added wait = tee - original: the foreign runtime is not Xaibo's, M16).
    const frames: { t0: bigint; tee: Timed; original: Timed; kind: 'valid' | 'malformed-kept' | 'malformed' }[] = [];
    const lastValidCost = new Map<string, number>(); // per Claude session: the cost its last valid frame reported
    const frameLoop = async (s: (typeof sessions)[number], i: number) => {
      for (let k = 1, next = start + 137 * i; !stopped && Date.now() < loadEndAt; k++, next += FRAME_MS) {
        const wait = next - Date.now();
        if (wait > 0) await sleep(wait);
        const bad = k % MALFORMED_EVERY === 0 ? malformed(s.sid, k / MALFORMED_EVERY) : null;
        const stdin = bad ? bad.stdin : frame(s.sid, k);
        // review L9: alternate which runs first, so neither always gets the warm caches
        let tee: Timed;
        let original: Timed;
        if (k % 2) { tee = await sh(teeCmd!, stdin); original = await sh(ORIGINAL, stdin); } else { original = await sh(ORIGINAL, stdin); tee = await sh(teeCmd!, stdin); }
        frames.push({ t0: tee.t0, tee, original, kind: bad ? (bad.keepsSession ? 'malformed-kept' : 'malformed') : 'valid' });
        if (!bad) lastValidCost.set(s.sid, (JSON.parse(stdin) as { cost: { total_cost_usd: number } }).cost.total_cost_usd);
      }
    };
    // Disk full at a quarter of the run: the volume filled to the byte, held, then freed. The window opens IN_FLIGHT_MS
    // before the fill (as the kill's) and closes RESTART_SETTLE_MS after the free.
    const banner = () => launched.page.getByText('Disk full: collection paused').first().isVisible().catch(() => false);
    let full: Window | null = null;
    const diskFull = { fillMs: null as number | null, bannerShown: false, bannerCleared: null as boolean | null, workspaceReopened: null as boolean | null,
      skipped: !vol }; // review L11: --no-disk-full passes diskFullFaulted by skipping it
    const fillFile = vol ? path.join(vol.mount, 'fill.bin') : '';
    const fault = async () => {
      await sleep((p.seconds * 1000) / 4);
      if (stopped) return; // review M7: another step failed; do not fill the disk on the way to cleanup
      const from = now() - BigInt(IN_FLIGHT_MS * 1e6);
      const t = Date.now();
      if (!fillVolume(fillFile)) throw new Error('could not fill the data volume');
      diskFull.fillMs = Date.now() - t;
      // the Coverage banner renders on the Dashboard only (P4-T14 carry-over): shown there while full, then back to Session
      const area = (name: string) => launched.page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name, exact: true }).click({ timeout: 5000 }).catch(() => undefined);
      await area('Dashboard');
      for (const end = Date.now() + FULL_HOLD_MS; Date.now() < end;) { diskFull.bannerShown ||= await banner(); await sleep(500); }
      unlinkSync(fillFile);
      for (const end = Date.now() + 15_000; Date.now() < end && await banner();) await sleep(250);
      diskFull.bannerCleared = !(await banner());
      // review H1: back in the Session area with the workspace open again before the window can close
      await area('Session');
      diskFull.workspaceReopened = await launched.page.getByText(`${CWD}-${sessions[0]!.sid}`).first().click({ timeout: 10_000 }).then(() => true, () => false);
      full = { from, to: now() + BigInt(RESTART_SETTLE_MS * 1e6) };
    };
    // M5 under load: summed phys_footprint of the app tree every 10 s, window open (as m4Probe measures M4).
    const footprints: (number | null)[] = [];
    // with the volume: its free space every 10 s (does the store itself fill it outside the fault?)
    const volumeFree: { atS: number; freeMiB: number }[] = [];
    const memLoop = async () => {
      while (!stopped && Date.now() < loadEndAt) {
        await sleep(10_000);
        if (vol) { const f = statfsSync(vol.mount); volumeFree.push({ atS: Math.round((Date.now() - start) / 1000), freeMiB: Math.round((f.bavail * f.bsize) / 2 ** 20) }); }
        const pids = await launched.app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => m.pid));
        footprints.push(footprintMiB(psTree(pids).map((x) => x.pid)));
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

    const stopOnFail = (e: unknown) => { stopped = true; throw e; };
    const settled = await Promise.allSettled([...sessions.map(run), kill().catch(stopOnFail),
      ...(usage ? [...sessions.filter((s) => s.agent === 'claude').map(frameLoop), memLoop()] : []), ...(vol ? [fault().catch(stopOnFail)] : [])]);
    const failed = settled.find((x) => x.status === 'rejected');
    if (failed) throw failed.reason; // every loop has stopped: cleanup below never races a writer
    // The end of load is the last emit, not the end of a slow restart (review M5).
    const loadEnd = emitted.reduce((m, e) => (e.t0 > m ? e.t0 : m), 0n);
    const backfillDone = imported();

    // Drain: wait until every event is painted (or 30 s), then judge drain from the trace.
    // P4-T12b: a trace line cut by the full disk is skipped (its events count as misses in the fault window) and counted
    let tornTrace = 0;
    const traceFile = (f: string) => readFileSync(path.join(dataDir, 'logs', f), 'utf8').split('\n').filter((x) => x.endsWith('}'))
      .flatMap((x) => { try { return [JSON.parse(x) as TraceLine]; } catch { tornTrace++; return []; } });
    const faults = () => (full ? [full as Window] : []);
    const result = () => (tornTrace = 0, analyze({ emitted, service: traceFile('perf-trace-service.jsonl'), main: traceFile('perf-trace-main.jsonl'), restart, faults: faults(), loadEnd }));
    resolveLate();
    let r = result();
    for (const end = Date.now() + 30_000; r.unpainted.steady + r.unpainted.restart > 0 && Date.now() < end;) { await sleep(1000); resolveLate(); r = result(); }
    // Spooled hooks reach the store by replay: the stored-once counts get the same 30 s.
    const storedOnce = () => {
      const files = reader.prepare('SELECT count(*) AS rows, count(DISTINCT native_id) AS ids FROM events WHERE native_id IN (SELECT value FROM json_each(?))').get(JSON.stringify(fileIds)) as { rows: number; ids: number };
      const sids = JSON.stringify(sessions.map((s) => s.sid));
      const hooks = Number((reader.prepare('SELECT count(*) AS n FROM hook_delivery WHERE native_session_id IN (SELECT value FROM json_each(?))').get(sids) as { n: number }).n);
      // a hook rejected while the disk was full could not spool either (same volume): the service keeps it as a gap (EC-44)
      const gaps = Number((reader.prepare("SELECT coalesce(sum(count), 0) AS n FROM hook_gaps WHERE reason = 'disk-full' AND native_session_id IN (SELECT value FROM json_each(?))").get(sids) as { n: number }).n);
      return { records: { sent: fileIds.length, rows: Number(files.rows), ids: Number(files.ids) }, hooks: { sent: hooksSent, rows: hooks, diskFullGaps: gaps } };
    };
    let stored = storedOnce();
    const hooksAccounted = () => stored.hooks.rows + stored.hooks.diskFullGaps >= stored.hooks.sent;
    for (const end = Date.now() + 30_000; (stored.records.ids < stored.records.sent || !hooksAccounted()) && Date.now() < end;) { await sleep(1000); stored = storedOnce(); }
    const u = usage ? await usageResult() : null;

    const w = restart as { from: bigint; to: bigint } | null;
    const checks = {
      m1: r.m1.steady.p95 <= B.m1 && r.m1.steady.n >= 100,
      m2: r.m2.steady.p95 <= B.m2 && r.m2.steady.n >= 100,
      queueAge: r.ingestLagMs.n > 0 && r.ingestLagMs.p95 <= B.queueAge, // emit -> commit; the writer's own queue is ~0 by design
      drain: r.drainMs <= B.drain,
      recordsOnce: stored.records.rows === stored.records.sent && stored.records.ids === stored.records.sent,
      // without faults other than the kill every hook is stored once; with the disk-full fault, stored or a disk-full gap
      hooksOnce: usage ? stored.hooks.rows <= stored.hooks.sent && hooksAccounted() : stored.hooks.rows === stored.hooks.sent,
      restarted: w !== null,
      // review M1: the load ran while the T1 corpus was still importing, with one session's workspace open
      backfillDuringLoad: backfillDone !== undefined && Date.parse(backfillDone.t) > start,
      workspaceOpen,
      ...(u ? u.checks : {}),
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
      ...(u ? { usage: u.report } : {}),
      checks, pass: Object.values(checks).every(Boolean), env: await environment(launched.app),
      ...(u ? { m4WindowClosed: await Promise.race([m4Short(), sleep(120_000).then(() => null)]).catch(() => null) } : {}), // null: main unreachable
    };

    /** --usage store checks after the drain, and the figures the report keeps. */
    async function usageResult() {
      const claudeSids = sessions.filter((s) => s.agent === 'claude').map((s) => s.sid);
      const live = JSON.stringify(sessions.map((s) => s.sid));
      const one = (sql: string, ...a: string[]) => Number(Object.values(reader.prepare(sql).get(...a) ?? {})[0] ?? 0);
      // live cost: every usage row of a live session priced (an estimate row, not dirty), polled while slices catch up
      // message scope only: cost.ts prices message rows; Codex session-scope totals are never priced on their own
      const unpriced = () => one(`SELECT count(*) FROM usage u JOIN sessions s ON s.id = u.session_id WHERE s.native_session_id IN (SELECT value FROM json_each(?))
        AND u.scope = 'message' AND NOT EXISTS (SELECT 1 FROM cost_estimates e WHERE e.session_id = u.session_id AND e.covered_scope = 'usage:' || u.source || ':' || u.identity AND e.dirty = 0)`, live);
      let left = unpriced();
      for (const end = Date.now() + 30_000; left > 0 && Date.now() < end;) { await sleep(1000); left = unpriced(); }
      const usageRows = one("SELECT count(*) FROM usage u JOIN sessions s ON s.id = u.session_id WHERE s.native_session_id IN (SELECT value FROM json_each(?)) AND u.scope = 'message'", live);
      const perSession = (table: string) => sessions.map((s) => one(`SELECT count(*) FROM ${table} x JOIN sessions s ON s.id = x.session_id WHERE s.native_session_id = ?`, s.sid));
      const statusline = one(`SELECT count(*) FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.source = 'statusline' AND s.native_session_id IN (SELECT value FROM json_each(?))`, JSON.stringify(claudeSids));
      // review M3: malformed frames (wrong types, a negative cost) never replace a session's reported cost: the stored
      // agent-reported amount is the last valid frame's
      const reportedCost = (sid: string) => (reader.prepare(`SELECT e.amount_usd AS a FROM cost_estimates e JOIN sessions s ON s.id = e.session_id
        WHERE s.native_session_id = ? AND e.covered_scope = 'session:statusline'`).get(sid) as { a: number | null } | undefined)?.a ?? null;
      const costMismatch = claudeSids.filter((sid) => lastValidCost.has(sid) && reportedCost(sid) !== lastValidCost.get(sid)).length;
      const w = [restart as Window | null, full as Window | null].filter((x): x is Window => x !== null);
      const outside = (f: (typeof frames)[number]) => !w.some((x) => f.t0 >= x.from && f.t0 <= x.to);
      const storable = frames.filter((f) => f.kind !== 'malformed');
      const added = frames.map((f) => f.tee.ms - f.original.ms);
      const addedSteady = frames.filter(outside).map((f) => f.tee.ms - f.original.ms);
      // review M4: steady samples only, as the tee figure (fault windows stall the forwarder by design)
      const dispatch = emitted.filter((e) => e.kind === 'hook' && e.exit !== undefined && !w.some((x) => e.t0 >= x.from && e.t0 <= x.to)).map((e) => Number(e.exit! - e.t0) / 1e6);
      const baseline = hookBaseline.filter((b) => !w.some((x) => b.t0 >= x.from && b.t0 <= x.to)).map((b) => b.ms);
      const fp = footprints.every((x) => x !== null) && footprints.length ? stats(footprints as number[]) : null;
      const callsFile = path.join(launched.root, 'agent-calls.log');
      const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : [];
      const report = {
        statuslineFrames: { sent: frames.length, valid: frames.filter((f) => f.kind === 'valid').length, malformed: frames.length - frames.filter((f) => f.kind === 'valid').length,
          storableOutsideFaults: storable.filter(outside).length, storable: storable.length, stored: statusline, reportedCostNotLastValid: costMismatch },
        // M16 tee: tee wall - original wall, same stdin, paired; steady = outside the fault windows
        teeAddedWaitMs: { steady: stats(addedSteady), all: stats(added) }, originalMs: stats(frames.map((f) => f.original.ms)),
        // M7: the tee adds 0 bytes (its stdout is the original's), writes no stderr, mirrors exit 0
        teeOutput: { extraStdoutBytes: frames.reduce((n, f) => n + Math.abs(f.tee.out - f.original.out), 0), stderrBytes: frames.reduce((n, f) => n + f.tee.err, 0),
          nonZeroExit: frames.filter((f) => f.tee.code !== 0).length },
        // M16 hooks under load: shim dispatch vs a bare spawn of `true` the same way, interleaved every 4th hook
        hookDispatchMs: stats(dispatch), spawnBaselineMs: stats(baseline), hookAddedWaitP95: stats(dispatch).p95 - stats(baseline).p95,
        codexTokenCount: tokenLines, statuslineQuotaHistory: one("SELECT count(*) FROM usage_history WHERE source = 'statusline'"),
        perSession: { usageSnapshots: perSession('usage_snapshots'), contextSnapshots: perSession('context_snapshots') },
        cost: { usageRows, unpricedAfterDrain: left },
        diskFull: { ...diskFull, windowMs: full ? Number((full as Window).to - (full as Window).from) / 1e6 : null, volumeGiB: VOLUME_GIB, holdMs: FULL_HOLD_MS },
        volume: vol ? { minFreeMiB: Math.min(...volumeFree.map((v) => v.freeMiB)), freeMiBEvery10s: volumeFree.map((v) => `${v.atS}:${v.freeMiB}`),
          storeMiB: Math.round(['xaibo.db', 'xaibo.db-wal'].reduce((n, f) => n + (existsSync(path.join(dataDir, f)) ? statSync(path.join(dataDir, f)).size : 0), 0) / 2 ** 20),
          walMiB: Math.round((existsSync(path.join(dataDir, 'xaibo.db-wal')) ? statSync(path.join(dataDir, 'xaibo.db-wal')).size : 0) / 2 ** 20) } : null,
        // seconds after the load start, full or recovered (lines written while full are lost by design, XAIBO-PROD-430)
        diskFullEvents: serviceLog(dataDir).filter((e) => e.event === 'disk_full').map((e) => `${Math.round((Date.parse(e.t) - start) / 1000)}:${(e as { full?: boolean }).full ? 'full' : 'ok'}`),
        renderer: { ...renderer, mainEvents: (await rendererEvents()).map((x) => x.replace(/:(\d{13})$/, (_m, t: string) => `:${Number(t) - launched.created}`)) },
        m5UnderLoadFootprintMiB: fp, serviceStarts: readies(), tornServiceLogLines: tornLogLines(dataDir), tornTraceLines: tornTrace,
        serviceEvents: Object.entries(serviceLog(dataDir).reduce<Record<string, number>>((m, e) => { m[e.event] = (m[e.event] ?? 0) + 1; return m; }, {})).filter(([k]) => !/^(scan|watch)/.test(k)),
        serviceErrors: serviceLog(dataDir).filter((e) => 'error' in e).map((e) => `${e.event}:${String((e as { error?: unknown }).error)}`).slice(0, 40), agentCalls: { count: calls.length, prohibited: calls.filter((c) => PROHIBITED.test(c)).length },
      };
      const checks = {
        statuslineStored: statusline >= report.statuslineFrames.storableOutsideFaults && statusline <= storable.length,
        malformedNeverReplacesCost: lastValidCost.size > 0 && costMismatch === 0,
        teeM16: addedSteady.length >= 100 && stats(addedSteady).p95 <= B.m16,
        teeM7: report.teeOutput.extraStdoutBytes === 0 && report.teeOutput.stderrBytes === 0 && report.teeOutput.nonZeroExit === 0,
        hookM16: baseline.length > 0 && report.hookAddedWaitP95 <= B.m16,
        codexUsage: tokenLines.valid > 0 && sessions.every((s, i) => s.agent !== 'codex' || (report.perSession.usageSnapshots[i]! > 0 && report.perSession.contextSnapshots[i]! > 0)),
        // Claude quota from the tee goes to usage_history (source statusline); context per session
        claudeUsage: report.statuslineQuotaHistory > 0 && sessions.every((s, i) => s.agent !== 'claude' || report.perSession.contextSnapshots[i]! > 0),
        livePriced: usageRows > 0 && left === 0,
        diskFullFaulted: !vol || (full !== null && diskFull.bannerShown && diskFull.bannerCleared === true),
        // the kill restarts the service once; a disk-full or malformed-snapshot crash would add starts
        noCrash: readies() === 2,
        m5UnderLoad: fp !== null && fp.max <= B.m5MB * 1e6 / 2 ** 20,
        noProhibitedCall: report.agentCalls.prohibited === 0,
      };
      return { report, checks };
    }

    /** M4 reported (the full 5-minute M4 is P4-T17): window closed after the load, 60 s, collecting. */
    async function m4Short() {
      await launched.app.evaluate(({ BrowserWindow }) => { for (const x of BrowserWindow.getAllWindows()) x.close(); });
      await sleep(10_000);
      await launched.app.evaluate(({ app: a }) => void a.getAppMetrics());
      const cpu: number[] = [];
      const fp: (number | null)[] = [];
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const m = await launched.app.evaluate(({ app: a }) => a.getAppMetrics().map((x) => ({ pid: x.pid, cpu: x.cpu.percentCPUUsage })));
        cpu.push(m.reduce((n, x) => n + x.cpu, 0));
        if (i % 10 === 9) fp.push(footprintMiB(psTree(m.map((x) => x.pid)).map((x) => x.pid)));
      }
      return { seconds: 60, footprintMiB: fp.every((x) => x !== null) ? stats(fp as number[]) : null, cpuPercent: stats(cpu), targets: { footprintMB: 250, cpuPercentMean: 1 } };
    }
  } finally {
    db?.close();
    if (l) await close(l);
    process.off('SIGINT', onSigint);
    let detached = true;
    try { vol?.detach(); } catch { detached = false; console.error(`perf: could not detach ${vol?.mount ?? ''}; left in place (hdiutil detach -force it)`); }
    if (detached) rmSync(root, { recursive: true, force: true }); // review L8: never delete through a mounted volume
  }
}
