// XAIBO-PROD-624 (P7-T04, EC-85, M11 launch portion): Launch in terminal → provisional Starting… row painted, p95 ≤ 300 ms,
// on the packaged app with the stubbed Terminal spawner (XAIBO_LAUNCH_STUB=1) and the native grant answered once (the warm-up
// run, not measured). Each sample: the dialog's preview is held, then the in-page clock runs from the click to two animation
// frames after the row is in the DOM (an upper bound on its paint). Rows are removed between samples; launches are 2 s apart.
//   npm run perf -- --tier T0 --only m11-launch [--runs 20]
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { close, environment, launch, sleep, stats } from './app.ts';

const BUDGET_MS = 300;

export async function m11Launch(runs: number) {
  const claude = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-claude-'));
  mkdirSync(path.join(claude, 'projects'));
  const l = await launch(claude, { env: { XAIBO_LAUNCH_STUB: '1' } });
  try {
    await l.app.evaluate(({ dialog: d }) => { d.showMessageBox = (async () => { await new Promise((r) => setTimeout(r, 900)); return { response: 1, checkboxChecked: false }; }) as typeof d.showMessageBox; });
    const cwd = path.join(l.root, 'project');
    mkdirSync(cwd);
    const page = l.page, ms: number[] = [];
    for (let i = 0; i <= runs; i++) {
      await page.getByRole('button', { name: 'Launch', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Launch an agent' });
      await dialog.getByRole('combobox', { name: 'Agent' }).waitFor();
      await page.waitForFunction(() => (document.getElementById('launch-agent') as HTMLSelectElement | null)?.value === 'claude', null, { timeout: 30_000 });
      await dialog.getByRole('textbox', { name: 'Working directory' }).fill(cwd);
      await page.waitForFunction(() => document.querySelector('.x-launch-dialog pre')?.textContent?.includes("'--session-id'"), null, { timeout: 30_000 });
      const t = await page.evaluate(() => new Promise<number>((resolve, reject) => {
        const button = [...document.querySelectorAll('.x-launch-dialog button')].find((b) => b.textContent === 'Launch in terminal') as HTMLButtonElement;
        const t0 = performance.now();
        button.click();
        const tick = () => {
          const li = document.querySelector('.x-provisional li');
          if (li && !li.textContent?.includes('Starting…')) reject(new Error('the launch row is not starting')); // Gate 7 (e3): a failed launch never counts
          else if (li) requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
          else if (performance.now() - t0 > 30_000) reject(new Error('no provisional row'));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }));
      await page.waitForTimeout(300); // Gate 7 (e3): the open succeeded (a failed open turns the row failed)
      if (!(await page.locator('.x-provisional li').first().textContent())?.includes('Starting…')) throw new Error('the launch failed');
      if (i > 0) ms.push(t); // run 0 includes the native grant dialog
      await page.getByRole('button', { name: 'Remove provisional row' }).click();
      await page.waitForFunction(() => !document.querySelector('.x-provisional li'), null, { timeout: 10_000 });
      await sleep(2_100); // the launch flow keeps launches 2 s apart
    }
    const s = stats(ms);
    return { metric: 'm11-launch', runs, launchToRowPaintMs: s, budgetMs: BUDGET_MS, pass: s.p95 <= BUDGET_MS, clock: 'renderer performance.now (monotonic)', env: await environment(l.app) };
  } finally {
    await close(l);
    rmSync(claude, { recursive: true, force: true });
    rmSync(l.root, { recursive: true, force: true });
  }
}
