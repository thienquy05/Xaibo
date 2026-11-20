// Perf harness helpers (P1-T14): launch the unpacked packaged app with Playwright `_electron` on a synthetic corpus
// (temp HOME, data dir, fake SHELL and agent binary; the corpus is read, never written), read its logs and store
// read-only, and summarize timings. Aggregates only leave this process.
import { execFileSync } from 'node:child_process';
import { _electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem, tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FIRST_PAGE_MARK, LONG_FRAME } from '../../src/renderer/perf-marks.ts';

export const REPO = path.resolve(import.meta.dirname, '..', '..');
const PACKAGED = path.join(REPO, 'release', 'mac-arm64', 'Xaibo.app', 'Contents', 'MacOS', 'Xaibo');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls `f` every `every` ms until it returns a truthy value; throws after `ms`. */
export async function until<T>(f: () => T | null | false | undefined, ms: number, every = 50): Promise<T> {
  const end = Date.now() + ms;
  for (let v = f(); ; v = f()) {
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await sleep(every);
  }
}
/** A synthetic session UUID: a 4-digit prefix and an 8-digit index. */
export const sidOf = (prefix: number, i: number) => `00000000-0000-4000-8000-${String(prefix).padStart(4, '0')}${String(i).padStart(8, '0')}`;
/** The Antigravity CLI root inside a synthetic home. */
export const agyRoot = (home: string) => path.join(home, '.gemini', 'antigravity-cli');

export interface Launched { app: ElectronApplication; page: Page; dataDir: string; root: string; created: number }

/** P2-T14: optional Codex home and agy profile root; agy has no env override, so its root is linked under the temp HOME.
 *  P4-T12b: `dataDir` places the data dir (a disk-image volume for the disk-full fault); the fake `claude` appends its
 *  arguments to `<root>/agent-calls.log`, so a run can check no prohibited command was invoked (FR-44). */
export async function launch(claudeDir: string, more: { codex?: string; agy?: string; env?: Record<string, string>; dataDir?: string } = {}): Promise<Launched> {
  const root = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-'));
  const home = path.join(root, 'home');
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(root, 'tmp'));
  if (more.agy) { mkdirSync(path.join(home, '.gemini'), { recursive: true }); symlinkSync(more.agy, path.join(home, '.gemini', 'antigravity-cli')); }
  const script = (name: string, body: string) => { const f = path.join(bin, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
  script('claude', `echo "$*" >> '${path.join(root, 'agent-calls.log')}'\necho "2.1.319 (Claude Code)"`);
  const shell = script('fake-shell', 'while [ $# -gt 0 ]; do [ "$1" = -c ] && exec /bin/sh -c "$2"; shift; done');
  const dataDir = more.dataDir ?? path.join(root, 'data');
  const env = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: shell, TMPDIR: path.join(root, 'tmp'), LANG: 'en_US.UTF-8',
    CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: more.codex ?? path.join(home, '.codex'), GEMINI_CLI_HOME: home, XAIBO_DATA_DIR: dataDir,
    ...more.env,
  };
  const app = await _electron.launch({ executablePath: PACKAGED, args: [], env, timeout: 60_000 });
  const page = await app.firstWindow();
  const created = (await app.evaluate(() => process.getCreationTime())) ?? Number.NaN;
  // P4-T04c: the app opens on the Dashboard; the perf scripts read the full list in the Session area (the M3 mark is
  // set by the list commit, which happens whichever area is shown).
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Session', exact: true }).click();
  return { app, page, dataDir, root, created };
}

/** Quits the app; if it is still running after 15 s it is killed (P3-T16b: a hung quit left the app and the probe
 *  running) and `timedOut` says so. */
export async function close(l: Launched): Promise<{ timedOut: boolean }> {
  const proc = l.app.process(); // taken before close: Playwright disposes the app object on close
  const timedOut = await Promise.race([l.app.close().then(() => false, () => false), sleep(15_000).then(() => true)]);
  // P4-T12b: a close that returns at once (the Playwright connection already broken) can leave the app running
  if (!timedOut && proc.exitCode === null && proc.signalCode === null) { await sleep(2000); if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }
  if (timedOut) {
    // evidence for the not-yet-reproduced quit hang: a stack sample of main and its children (local, git-ignored)
    let children = '';
    try { children = execFileSync('/usr/bin/pgrep', ['-P', String(proc.pid)], { encoding: 'utf8' }); } catch { /* none (exit 1) */ }
    const pids = [proc.pid, ...children.split('\n').filter(Boolean).map(Number)];
    mkdirSync(path.join(REPO, '.cache', 'perf'), { recursive: true });
    for (const pid of pids) {
      try { writeFileSync(path.join(REPO, '.cache', 'perf', `quit-hang-${Date.now()}-${pid}.txt`), execFileSync('/usr/bin/sample', [String(pid), '2', '-mayDie'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* gone */ }
    }
    proc.kill('SIGKILL');
  }
  rmSync(l.root, { recursive: true, force: true });
  return { timedOut };
}

export function serviceLog(dataDir: string): { t: string; event: string }[] {
  const f = path.join(dataDir, 'logs', 'service', 'xaibo.log');
  if (!existsSync(f)) return [];
  // P4-T12b: a line cut by a full disk is skipped here and counted by tornLogLines
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as { t: string; event: string }]; } catch { return []; } });
}
export const tornLogLines = (dataDir: string) => {
  const f = path.join(dataDir, 'logs', 'service', 'xaibo.log');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => { if (!l) return false; try { JSON.parse(l); return false; } catch { return true; } }).length : 0;
};

/** Polls the service log for an event; its time (ms since epoch), or null after timeoutMs. */
export async function waitForEvent(dataDir: string, event: string, timeoutMs: number, onTick?: () => Promise<void>): Promise<number | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const e = serviceLog(dataDir).find((x) => x.event === event);
    if (e) return Date.parse(e.t);
    await onTick?.();
    await sleep(100);
  }
  return null;
}

export function query<T>(dataDir: string, sql: string, ...params: (string | number)[]): T {
  const db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
  try { return Object.values(db.prepare(sql).get(...params) ?? {})[0] as T; } finally { db.close(); }
}

export const fileBytes = (f: string) => (existsSync(f) ? statSync(f).size : 0);

/** G5-N1: Settings > Session retention > Never > Save (as test/e2e/settings-retention.spec.ts), then back to the Session
 *  area. The app's own retention run (10 min after each backfill, real clock) would otherwise purge a corpus dated early
 *  2026 mid-measurement (t1mix: 1,000 sessions in ~533 s); with Never it only expires quota history older than 45 days. */
export async function retentionNever(l: Launched): Promise<void> {
  const areas = l.page.getByRole('navigation', { name: 'Areas' });
  await areas.getByRole('link', { name: 'Settings' }).click();
  const section = l.page.getByRole('region', { name: 'Session retention' });
  await section.getByRole('radio', { name: 'Never' }).check({ timeout: 60_000 }); // enabled once the stored setting is read
  await section.getByRole('button', { name: 'Save' }).click();
  await section.getByText('Saved.').waitFor({ timeout: 60_000 });
  await areas.getByRole('link', { name: 'Session', exact: true }).click();
}

/** The app's own retention runs logged since `since` (ms): when each ended (at, ms; atS after `since`) and what it purged or
 *  expired (retention_run is logged at the end of a run). */
export const retentionRuns = (dataDir: string, since: number) => serviceLog(dataDir)
  .filter((e) => e.event === 'retention_run' && Date.parse(e.t) >= since)
  .map((e) => {
    const x = e as { t: string; sessions?: number; trash?: number; quota?: number };
    const at = Date.parse(x.t);
    return { at, atS: Math.round((at - since) / 1000), sessions: x.sessions ?? 0, trash: x.trash ?? 0, quota: x.quota ?? 0 };
  });

/** G5e-1: PRD §6.6 TP is a ~1,500-session corpus with a ~2.6 GiB DB; a smaller import measures a smaller history. */
export const TP_MIN = { sessions: 1450, dbBytes: 2.4 * 2 ** 30 };
export function tpWorkload(dataDir: string): { sessions: number; dbBytes: number } {
  const sessions = Number(query<number>(dataDir, 'SELECT count(*) FROM sessions'));
  const dbBytes = fileBytes(path.join(dataDir, 'xaibo.db')) + fileBytes(path.join(dataDir, 'xaibo.db-wal'));
  if (sessions < TP_MIN.sessions || dbBytes < TP_MIN.dbBytes) {
    throw new Error(`TP workload too small: ${sessions} sessions and ${(dbBytes / 2 ** 30).toFixed(2)} GiB DB+WAL imported; PRD §6.6 TP needs `
      + `>= ${TP_MIN.sessions} sessions and >= ~2.4 GiB. Regenerate: node scripts/gen-perf-corpus.ts --case tp`);
  }
  return { sessions, dbBytes };
}

export { stats } from './stats.ts'; // P4-T11: in its own module, so the pure t2 analysis loads without Playwright

export async function environment(app: ElectronApplication) {
  const v = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }));
  return { hardware: process.arch === 'arm64' ? 'Apple Silicon' : process.arch, cores: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30),
    darwin: release(), ...v };
}

/** One cold run: time from process creation to the first-usable-page mark (null if it never comes), then the long
 *  frames recorded around it during the import (P1-T14; shared by m3-first-list and m3-full). */
export async function firstPage(l: Launched): Promise<{ ms: number | null; longFrames: number[] }> {
  const markAt = await l.page.evaluate(async ({ name, timeout }) => {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      const e = performance.getEntriesByName(name)[0];
      if (e) return performance.timeOrigin + e.startTime;
      await new Promise((r) => setTimeout(r, 10));
    }
    return null;
  }, { name: FIRST_PAGE_MARK, timeout: 30_000 });
  await sleep(2_000); // long frames around the first page, during the import
  return { ms: markAt === null || Number.isNaN(l.created) ? null : markAt - l.created, longFrames: await longFramesOf(l) };
}

export const longFramesOf = (l: Launched) => l.page.evaluate((n) => performance.getEntriesByName(n).map((e) => e.duration), LONG_FRAME);
