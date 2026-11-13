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

export interface Launched { app: ElectronApplication; page: Page; dataDir: string; root: string; created: number }

/** P2-T14: optional Codex home and agy profile root; agy has no env override, so its root is linked under the temp HOME. */
export async function launch(claudeDir: string, more: { codex?: string; agy?: string; env?: Record<string, string> } = {}): Promise<Launched> {
  const root = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-'));
  const home = path.join(root, 'home');
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(root, 'tmp'));
  if (more.agy) { mkdirSync(path.join(home, '.gemini'), { recursive: true }); symlinkSync(more.agy, path.join(home, '.gemini', 'antigravity-cli')); }
  const script = (name: string, body: string) => { const f = path.join(bin, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
  script('claude', 'echo "2.1.319 (Claude Code)"');
  const shell = script('fake-shell', 'while [ $# -gt 0 ]; do [ "$1" = -c ] && exec /bin/sh -c "$2"; shift; done');
  const dataDir = path.join(root, 'data');
  const env = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: shell, TMPDIR: path.join(root, 'tmp'), LANG: 'en_US.UTF-8',
    CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: more.codex ?? path.join(home, '.codex'), GEMINI_CLI_HOME: home, XAIBO_DATA_DIR: dataDir,
    ...more.env,
  };
  const app = await _electron.launch({ executablePath: PACKAGED, args: [], env, timeout: 60_000 });
  const page = await app.firstWindow();
  const created = (await app.evaluate(() => process.getCreationTime())) ?? Number.NaN;
  return { app, page, dataDir, root, created };
}

/** Quits the app; if it is still running after 15 s it is killed (P3-T16b: a hung quit left the app and the probe
 *  running) and `timedOut` says so. */
export async function close(l: Launched): Promise<{ timedOut: boolean }> {
  const timedOut = await Promise.race([l.app.close().then(() => false, () => false), sleep(15_000).then(() => true)]);
  if (timedOut) {
    // evidence for the not-yet-reproduced quit hang: a stack sample of main and its children (local, git-ignored)
    let children = '';
    try { children = execFileSync('/usr/bin/pgrep', ['-P', String(l.app.process().pid)], { encoding: 'utf8' }); } catch { /* none (exit 1) */ }
    const pids = [l.app.process().pid, ...children.split('\n').filter(Boolean).map(Number)];
    mkdirSync(path.join(REPO, '.cache', 'perf'), { recursive: true });
    for (const pid of pids) {
      try { writeFileSync(path.join(REPO, '.cache', 'perf', `quit-hang-${Date.now()}-${pid}.txt`), execFileSync('/usr/bin/sample', [String(pid), '2', '-mayDie'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* gone */ }
    }
    l.app.process().kill('SIGKILL');
  }
  rmSync(l.root, { recursive: true, force: true });
  return { timedOut };
}

export function serviceLog(dataDir: string): { t: string; event: string }[] {
  const f = path.join(dataDir, 'logs', 'service', 'xaibo.log');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string; event: string });
}

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

export function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? Number.NaN;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.at(-1) ?? Number.NaN, mean: s.reduce((a, b) => a + b, 0) / (s.length || 1) };
}

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
