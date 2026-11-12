// Shared Playwright fixture (P1-T05; EC-60, EC-61, M6). Every launch goes through audit-launch.sh, so the app runs
// under the S10 kill-on-attempt profile with Chromium NetLog on, in an isolated temp HOME, data dir and agent homes
// (fake SHELL, fake agent binaries first on PATH), with cwd at the repo root. After every test: no process killed or
// gone unexpectedly, NetLog without non-loopback hosts, `git status` unchanged, fixture agent stores byte-identical.
// The renderer interception count (`request_blocked` in the app log) is supporting evidence only.
import { _electron, expect, test as base } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gitStatus, parseNetLog, treeHashes, unexpectedDeaths } from './audit.ts';
import type { Gone, NetLogResult } from './audit.ts';

export const REPO = path.resolve(import.meta.dirname, '..', '..');
const PACKAGED = path.join(REPO, 'release', 'mac-arm64', 'Xaibo.app', 'Contents', 'MacOS', 'Xaibo');
const ELECTRON = createRequire(import.meta.url)('electron') as string;
const WRAPPER = path.join(import.meta.dirname, 'audit-launch.sh');
const PROFILE = path.join(import.meta.dirname, 'audit.sb');
const FIXTURE = path.join(REPO, 'test', 'fixtures', 'synthetic', 'claude', '2.1.319', 'usage-basic');
const STORES = ['.claude', '.codex', '.gemini'];
const MARK = 'xaibo-audit ';
const QUIT_MS = 10_000;

export interface LaunchOptions {
  dataDir?: string;
  unpackaged?: boolean;
  /** Denied attempts are not killed (the NetLog control needs the process to survive). */
  logOnly?: boolean;
  /** The test makes an attempt on purpose: teardown then requires that a detector fired. */
  expectAttempt?: boolean;
  serviceKills?: number;
  /** Extra environment for the app (e.g. XAIBO_PERF_TRACE=1, P3-T10). */
  env?: Record<string, string>;
}
export interface Exit { code: number | null; signal: NodeJS.Signals | null }
export interface Run { proc: ChildProcess; app?: ElectronApplication; dataDir: string; netlog: string; gone: Gone[]; exit: Promise<Exit>; opts: LaunchOptions }
export interface Audit { exit: Exit; deaths: number; netlog: NetLogResult }
export interface Xaibo {
  home: string;
  launch(o?: LaunchOptions): Promise<Run>;
  /** A launch outside Playwright (e.g. a second instance that is expected to exit on its own). */
  launchRaw(o?: LaunchOptions): Run;
  window(run: Run): Promise<Page>;
  quit(run: Run): Promise<Exit>;
  audit(run: Run): Promise<Audit>;
  /** The test's own write to a fixture agent store (e.g. a transcript append): the stores must be unchanged before
   *  it, and the post-write state becomes the expected one. */
  touchStore(write: () => void): void;
}

export const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const running = (p: ChildProcess) => p.exitCode === null && p.signalCode === null;
// 'close', not 'exit': audit lines may still be in the pipe when the process exits.
const closed = (p: ChildProcess) => new Promise<Exit>((res) => p.once('close', (code, signal) => res({ code, signal })));

export async function servicePid(app: ElectronApplication): Promise<number> {
  let pid: number | undefined;
  // fork's serviceName shows up as `name`; the metric's own `serviceName` is Chromium's internal service id.
  await expect.poll(async () => (pid = await app.evaluate(({ app: a }) => a.getAppMetrics().find((m) => m.name === 'xaibo-service')?.pid))).toBeTruthy();
  return pid!;
}

function makeHome(root: string) {
  const home = path.join(root, 'home');
  const bin = path.join(home, 'bin');
  const project = path.join(home, '.claude', 'projects', '-tmp-xaibo-fixture-project');
  for (const d of [bin, project, path.join(home, '.codex', 'sessions'), path.join(home, '.gemini'), path.join(root, 'tmp')]) mkdirSync(d, { recursive: true });
  for (const f of readdirSync(FIXTURE).filter((n) => n.endsWith('.jsonl'))) copyFileSync(path.join(FIXTURE, f), path.join(project, f));
  const script = (name: string, body: string) => {
    const f = path.join(bin, name);
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  script('claude', 'echo "2.1.319 (Claude Code)"');
  script('codex', 'echo "codex-cli 0.160.0"');
  const shell = script('fake-shell', 'while [ $# -gt 0 ]; do [ "$1" = -c ] && exec /bin/sh -c "$2"; shift; done');
  return { home, bin, shell };
}

export const test = base.extend<{ xaibo: Xaibo }>({
  xaibo: async ({}, use) => {
    const root = mkdtempSync(path.join(tmpdir(), 'xaibo-e2e-'));
    const { home, bin, shell } = makeHome(root);
    const logOnlyProfile = path.join(root, 'audit-log-only.sb');
    writeFileSync(logOnlyProfile, readFileSync(PROFILE, 'utf8').replaceAll(' (with send-signal SIGKILL)', ''));
    const storesOf = () => JSON.stringify(STORES.map((d) => treeHashes(path.join(home, d))));
    let storesBefore = storesOf();
    const problems: string[] = [];
    const gitBefore = gitStatus(REPO);
    const runs: Run[] = [];

    const prepare = (o: LaunchOptions) => {
      const dataDir = o.dataDir ?? mkdtempSync(path.join(root, 'data-'));
      const netlog = path.join(root, `netlog-${runs.length}.json`);
      const env: Record<string, string> = {
        HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: shell, TMPDIR: path.join(root, 'tmp'), LANG: 'en_US.UTF-8',
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), GEMINI_CLI_HOME: home,
        XAIBO_DATA_DIR: dataDir, XAIBO_AUDIT_PROFILE: o.logOnly ? logOnlyProfile : PROFILE, XAIBO_AUDIT_BIN: o.unpackaged ? ELECTRON : PACKAGED,
        ...o.env,
      };
      return { dataDir, netlog, env, args: [...(o.unpackaged ? [REPO] : []), `--log-net-log=${netlog}`] };
    };
    const track = (proc: ChildProcess, run: Omit<Run, 'proc' | 'gone' | 'exit'>): Run => {
      const r: Run = { ...run, proc, gone: [], exit: closed(proc) };
      let buf = '';
      proc.stdout?.on('data', (d: Buffer) => {
        buf += d;
        for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
          const line = buf.slice(0, i);
          if (line.startsWith(MARK)) r.gone.push(JSON.parse(line.slice(MARK.length)) as Gone);
        }
      });
      proc.stderr?.resume();
      runs.push(r);
      return r;
    };

    const x: Xaibo = {
      home,
      async launch(o = {}) {
        const { dataDir, netlog, env, args } = prepare(o);
        const app = await _electron.launch({ executablePath: WRAPPER, args, env, cwd: REPO, timeout: 30_000 });
        const r = track(app.process(), { app, dataDir, netlog, opts: o });
        await app.evaluate(({ app: a }, mark) => {
          const say = (type: string, reason: string, name: string) => process.stdout.write(`${mark}${JSON.stringify({ type, reason, name })}\n`);
          a.on('child-process-gone', (_e, d) => say(d.type, d.reason, d.name ?? d.serviceName ?? ''));
          a.on('render-process-gone', (_e, _wc, d) => say('Renderer', d.reason, ''));
        }, MARK);
        return r;
      },
      launchRaw(o = {}) {
        const { dataDir, netlog, env, args } = prepare(o);
        return track(spawn(WRAPPER, args, { env, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }), { dataDir, netlog, opts: o });
      },
      async window(run) {
        const page = await run.app!.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        return page;
      },
      async quit(run) {
        if (running(run.proc)) {
          if (run.app) await run.app.evaluate(({ app: a }) => a.quit()).catch(() => {});
          else run.proc.kill('SIGTERM');
          const done = await Promise.race([run.exit, sleep(QUIT_MS).then(() => null)]);
          if (!done) { run.proc.kill('SIGKILL'); throw new Error(`did not quit within ${QUIT_MS} ms`); }
        }
        return run.exit;
      },
      async audit(run) {
        const exit = await run.exit;
        let netlog: NetLogResult;
        try { netlog = parseNetLog(readFileSync(run.netlog, 'utf8')); } catch { netlog = { parsed: false, events: 0, nonLocal: 0, types: [] }; }
        return { exit, deaths: unexpectedDeaths(run.gone, { serviceKills: run.opts.serviceKills ?? 0 }), netlog };
      },
      touchStore(write) {
        if (storesOf() !== storesBefore) problems.push('fixture agent stores changed before the test wrote to them');
        write();
        storesBefore = storesOf();
      },
    };

    await use(x);

    for (const [i, r] of runs.entries()) await x.quit(r).catch((e: Error) => problems.push(`run ${i}: ${e.message}`));
    for (const [i, r] of runs.entries()) {
      const a = await x.audit(r);
      const fired = a.exit.signal === 'SIGKILL' || a.deaths > 0 || a.netlog.nonLocal > 0;
      if (r.opts.expectAttempt) { if (!fired) problems.push(`run ${i}: the deliberate attempt was not detected`); continue; }
      if (a.exit.signal || a.exit.code !== 0) problems.push(`run ${i}: exit code ${a.exit.code} signal ${a.exit.signal}`);
      if (a.deaths) problems.push(`run ${i}: ${a.deaths} unexpected process deaths ${JSON.stringify(r.gone)}`);
      if (r.app && !a.netlog.parsed) problems.push(`run ${i}: NetLog unreadable`);
      if (a.netlog.nonLocal) problems.push(`run ${i}: ${a.netlog.nonLocal} non-loopback NetLog events (${a.netlog.types.join(', ')})`);
    }
    if (gitStatus(REPO) !== gitBefore) problems.push('repo working tree changed during the test');
    if (storesOf() !== storesBefore) problems.push('fixture agent stores changed during the test');
    rmSync(root, { recursive: true, force: true });
    expect(problems, 'E2E audit').toEqual([]);
  },
});

export { expect };
