// S1 check (P0-S1-T1/T3). Run unsandboxed after `npm run dist:mac`:
//   node spikes/s1/check.ts            probe: packaged utilityProcess + worker, criteria from the service report
//   node spikes/s1/check.ts --crash    200 seeded service SIGKILLs + 20 main SIGKILLs, invariants (a)-(e) each time
// Raw output: .cache/spike-results/s1/ (git-ignored).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { mulberry32 } from '../shared/bench.ts';

const REPO = join(import.meta.dirname, '..', '..');
const BIN = join(REPO, 'dist/spike/mac-arm64/XaiboSpike.app/Contents/MacOS/XaiboSpike');
const OUT = join(REPO, '.cache', 'spike-results', 's1');
const STEP_TIMEOUT_MS = 30_000;
const SERVICE_KILLS = Number(process.env.S1_SERVICE_KILLS ?? 200);
const MAIN_KILLS = Number(process.env.S1_MAIN_KILLS ?? 20);
const KILL_MIN_MS = 50;
const KILL_SPAN_MS = 450;

type Msg = Record<string, any>;
class App {
  child: ChildProcess;
  msgs: Msg[] = [];
  private buf = '';
  exited: Promise<number | null>;
  constructor(dataDir: string, mode: string, extraEnv: NodeJS.ProcessEnv = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, XAIBO_DATA_DIR: dataDir, XAIBO_SPIKE_MODE: mode, ...extraEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = spawn(BIN, [], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    this.child.stdout!.on('data', (d: Buffer) => {
      this.buf += d;
      for (let i; (i = this.buf.indexOf('\n')) >= 0; this.buf = this.buf.slice(i + 1)) {
        try { this.msgs.push(JSON.parse(this.buf.slice(0, i))); } catch { /* not ours */ }
      }
    });
    this.exited = new Promise((res) => this.child.on('exit', res));
  }
  async next(pred: (m: Msg) => boolean, from = 0): Promise<[Msg, number]> {
    const end = Date.now() + STEP_TIMEOUT_MS;
    for (;;) {
      for (let i = from; i < this.msgs.length; i++) if (pred(this.msgs[i])) return [this.msgs[i], i + 1];
      if (Date.now() > end) throw new Error('timeout waiting for app message');
      if (this.child.exitCode !== null) throw new Error('app exited');
      await sleep(10);
    }
  }
}

const orphans = () => { try { return execFileSync('/usr/bin/pgrep', ['-f', 'XaiboSpike'], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const fail = (msg: string) => { console.log(`FAIL ${msg}`); process.exitCode = 1; };

async function probe() {
  const dir = mkdtempSync(join(tmpdir(), 's1-probe-'));
  const app = new App(dir, 's1-probe');
  try {
    const [m] = await app.next((x) => 'report' in x || x.service?.type === 'error');
    if (!('report' in m)) return fail(m.service.message);
    await app.exited;
    const stderrText = app.msgs.filter((x) => 'serviceStderr' in x).map((x) => x.serviceStderr).join('');
    m.report.experimentalWarning = /ExperimentalWarning/.test(stderrText);
    m.report.experimentalWarningText = (stderrText.match(/ExperimentalWarning[^\n]*/) ?? [''])[0].slice(0, 160);
    writeFileSync(join(OUT, 'probe.json'), JSON.stringify(m.report, null, 2));
    const r = m.report;
    for (const where of ['main', 'worker'] as const) {
      const p = r[where];
      if (!p) { fail(`${where}: no result`); continue; }
      if (p.error) { fail(`${where}: ${p.error}`); continue; }
      const checks: [string, boolean][] = [
        ['opens', p.opened === true],
        ['wal', p.pragmas?.journal_mode === 'wal'],
        ['synchronous NORMAL', p.pragmas?.synchronous === 1],
        ['foreign_keys', p.pragmas?.foreign_keys === 1],
        ['busy_timeout', p.pragmas?.busy_timeout === 5000],
        ['auto_vacuum INCREMENTAL', p.pragmas?.auto_vacuum === 2],
        ['temp_store MEMORY', p.pragmas?.temp_store === 2],
        ['fts5 match/snippet/bm25', p.fts?.match === true && p.fts?.snippet === true && p.fts?.bm25 === true],
        ['fts5 integrity-check', p.fts?.integrity === true],
        ['transactions', p.tx?.commit === true && p.tx?.rollback === true && p.tx?.savepoint === true],
        ['prepared reuse 10k', p.tx?.reuse === 10_000],
        ['readOnly snapshot isolation', p.isolation?.beforeCommit === p.isolation?.base && p.isolation?.afterCommit === p.isolation.base + 1],
      ];
      if (where === 'main') checks.push(['ENABLE_FTS5', r.compileOptions?.includes('ENABLE_FTS5')], ['backup API', r.backup === true]);
      for (const [name, ok] of checks) if (!ok) fail(`${where}: ${name}`);
    }
    if (!process.exitCode) console.log('s1 probe: pass');
  } finally {
    if (app.child.exitCode === null) app.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

function invariantsOk(c: Msg, acked: Set<number>, label: string): boolean {
  const bad = [
    c.integrity !== 'ok' && 'a integrity_check',
    c.ftsIntegrity !== true && 'b fts integrity',
    c.checkpointsMatch !== true && 'c checkpoint vs events',
    ![...acked].every((s) => s <= c.maxSeq) && 'd acked batch missing',
    c.contiguous !== true && 'd batches not contiguous',
    c.journalMode !== 'wal' && 'e journal_mode',
  ].filter(Boolean);
  if (bad.length) fail(`${label}: ${bad.join(', ')}`);
  return bad.length === 0;
}

async function crash() {
  const dir = mkdtempSync(join(tmpdir(), 's1-crash-'));
  const rand = mulberry32(1);
  const acked = new Set<number>();
  const extra = process.env.S1_TWO_TX ? { XAIBO_S1_TWO_TX: '1' } : {};
  let okService = 0;
  let okMain = 0;
  try {
    let app = new App(dir, 's1-crash', extra);
    let cursor = 0;
    for (let k = 0; k <= SERVICE_KILLS; k++) {
      let pidMsg: Msg; let check: Msg;
      [pidMsg, cursor] = await app.next((m) => 'service-pid' in m, cursor);
      // acks that count: only those the killed instance sent, i.e. before this instance's spawn message
      for (const m of app.msgs.slice(0, cursor)) if ('ack' in m) acked.add(m.ack);
      [check, cursor] = await app.next((m) => 'check' in m, cursor);
      if (invariantsOk(check.check, acked, `service restart ${k}`) && k > 0) okService++;
      if (k === SERVICE_KILLS) break;
      await sleep(KILL_MIN_MS + Math.floor(rand() * KILL_SPAN_MS));
      process.kill(pidMsg['service-pid'], 'SIGKILL');
    }
    for (let k = 1; k <= MAIN_KILLS; k++) {
      await sleep(KILL_MIN_MS + Math.floor(rand() * KILL_SPAN_MS));
      for (const m of app.msgs) if ('ack' in m) acked.add(m.ack);
      app.child.kill('SIGKILL');
      await app.exited;
      await sleep(2_000);
      const left = orphans();
      if (left) { fail(`main kill ${k}: orphan processes remain`); for (const p of left.split('\n')) process.kill(Number(p), 'SIGKILL'); }
      app = new App(dir, 's1-crash', extra);
      const [check] = await app.next((m) => 'check' in m);
      if (invariantsOk(check.check, acked, `main restart ${k}`) && !left) okMain++;
    }
    app.child.kill('SIGTERM');
    await app.exited;
    const summary = { serviceKills: SERVICE_KILLS, serviceOk: okService, mainKills: MAIN_KILLS, mainOk: okMain, acked: acked.size, twoTxStub: !!process.env.S1_TWO_TX };
    writeFileSync(join(OUT, 'crash.json'), JSON.stringify(summary, null, 2));
    console.log(`s1 crash: service ${okService}/${SERVICE_KILLS}, main ${okMain}/${MAIN_KILLS}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
await (process.argv.includes('--crash') ? crash() : probe());
