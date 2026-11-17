// P4-T17 (plan §3.5 M5, M4 re-measure; PRD M4/M5). Packaged app on the T1 mixed corpus (imported first) plus 50 seeded
// live sessions (30 Claude, 20 Codex: the T2 session count; the T2 event rate stays in the scale-up stage, D-P4-07),
// idle after one record each. Three phases of `seconds` each, sampled as M4 (P3-T16b): window open on the Dashboard's
// Live sessions view (M5), window open with one session's workspace in the Session area (M5), window closed (M4).
// Checks: M5 phases footprint <= 450 MB, M4 footprint <= 250 MB with mean CPU <= 1%, 5 minutes each. Aggregates only.
import { randomUUID } from 'node:crypto';
import { appendFileSync, constants, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { close, environment, launch, sleep, waitForEvent, type Launched } from './app.ts';
import { M4_CPU, M4_MB, mib, sampleTree, TREE_NOTES } from './m16.ts';
import { claudeLine, codexLine, CWD, PROFILES, seedSessions } from './t2.ts';

const M5_MB = 450;

export async function m4m5Probe(corpus: string, seconds: number) {
  const root = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-m5-'));
  let l: Launched | undefined;
  try {
    const home = path.join(root, 'home');
    cpSync(path.join(corpus, 'home'), home, { recursive: true, mode: constants.COPYFILE_FICLONE_FORCE, preserveTimestamps: true });
    const sessions = seedSessions(home, PROFILES.T2.sessions, PROFILES.T2.codexShare);
    l = await launch(path.join(home, '.claude'), { codex: path.join(home, '.codex'), agy: path.join(home, '.gemini', 'antigravity-cli') });
    const { app, page, dataDir } = l;
    const env = await environment(app);
    if (await waitForEvent(dataDir, 'backfill_done', 30 * 60_000) === null) throw new Error('import never finished');
    // one live record each after the import (a backfill never loads the status engine, D-P3-09), then idle
    for (const s of sessions) appendFileSync(s.file, s.agent === 'codex' ? codexLine(400) : claudeLine(s.sid, randomUUID(), 400, 1));

    await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Dashboard', exact: true }).click();
    await page.getByRole('group', { name: 'Dashboard view' }).getByRole('button', { name: 'Live sessions' }).click();
    const liveRows = async () => Number(await page.locator('[aria-label="Live sessions"][data-count]').getAttribute('data-count', { timeout: 1000 }).catch(() => '0'));
    const end = Date.now() + 120_000;
    let live = await liveRows();
    while (live < sessions.length && Date.now() < end) { await sleep(500); live = await liveRows(); }
    await sleep(10_000); // the delta flush and paint settle
    const overview = await sampleTree(app, seconds);

    // a live record's Open session button opens its workspace in the Session area (P4-T05d)
    await page.locator('[aria-label="Live sessions"]').getByRole('button', { name: new RegExp(`^Open session: .+ · ${CWD}-`) }).first().click({ timeout: 10_000 });
    const workspaceOpen = await page.getByRole('group', { name: 'Session section' }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    await sleep(10_000);
    const workspace = await sampleTree(app, seconds);

    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); }); // hides (tray app)
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()));
    await sleep(10_000); // the close settles
    const closed = await sampleTree(app, seconds);

    const under = (fp: { max: number } | null, mb: number) => fp !== null && fp.max <= mib(mb);
    const checks = {
      fiveMinutes: seconds >= 300, liveSessions: live >= sessions.length, workspaceOpen, windowHidden: !visible,
      m5Overview: under(overview.footprintMiB, M5_MB), m5Workspace: under(workspace.footprintMiB, M5_MB),
      m4Footprint: under(closed.footprintMiB, M4_MB), m4Cpu: closed.cpuPercent.mean <= M4_CPU,
    };
    const quit = await close(l);
    l = undefined;
    return { metric: 'm4-m5', seconds, targets: { m5FootprintMB: M5_MB, m4FootprintMB: M4_MB, m4CpuPercentMean: M4_CPU }, liveRows: live,
      overview, workspace, closed, notes: TREE_NOTES, checks, pass: Object.values(checks).every(Boolean), quitTimedOut: quit.timedOut, env };
  } finally {
    if (l) await close(l);
    rmSync(root, { recursive: true, force: true });
  }
}
