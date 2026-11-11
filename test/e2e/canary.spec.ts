// XAIBO-PROD-111 (P1-T13; EC-33, EC-35, M9): a runtime-generated canary transcript is stored in full in the private
// store (0600/0700), and after an induced error none of the canary forms appear in the diagnostics bundle, the logs or
// the test artifacts; no crash report is written. Canaries exist only in memory and in temp dirs.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canaries } from '../helpers/canary.ts';
import { saveArtifact } from './artifacts.ts';
import { expect, test } from './fixtures.ts';

const SESSION = '00000000-0000-4000-8000-00000000ca01';
const files = (dir: string): string[] => {
  try { return readdirSync(dir, { recursive: true }).map(String).map((f) => path.join(dir, f)).filter((f) => statSync(f).isFile()); } catch { return []; }
};
const mode = (p: string) => statSync(p).mode & 0o777;

test('EC-33/M9: canaries are stored locally in full and reach no egress path', async ({ xaibo }, testInfo) => {
  const c = canaries();
  const text = Object.values(c).join(' | ');
  const forms = Object.values(c).flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]);
  const hits = (file: string) => { const s = readFileSync(file, 'utf8'); return forms.filter((f) => s.includes(f)).length; };
  xaibo.touchStore(() => writeFileSync(path.join(xaibo.home, '.claude', 'projects', '-tmp-xaibo-fixture-project', `${SESSION}.jsonl`),
    JSON.stringify({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-00000000ca02', timestamp: '2026-01-04T00:00:00.000Z',
      cwd: '/tmp/xaibo-fixture/canary', sessionId: SESSION, message: { role: 'user', content: text } }) + '\n'));
  const run = await xaibo.launch();
  await xaibo.window(run);
  const db = path.join(run.dataDir, 'xaibo.db');
  await expect.poll(() => {
    let d: DatabaseSync | undefined;
    try {
      d = new DatabaseSync(db, { readOnly: true });
      return Number(Object.values(d.prepare('SELECT count(*) FROM events WHERE content = ?').get(text) ?? {})[0]);
    } catch { return 0; } finally { d?.close(); }
  }, { timeout: 15_000 }).toBe(1);

  // An uncaught error in main whose message and code are canaries.
  await run.app!.evaluate((_e, msg) => { setTimeout(() => { throw Object.assign(new Error(msg), { code: msg }); }, 0); }, text);
  const logFile = path.join(run.dataDir, 'logs', 'xaibo.log');
  await expect.poll(() => readFileSync(logFile, 'utf8').includes('"event":"uncaught_exception"')).toBe(true);

  // Save diagnostics through the real menu item, with the save dialog stubbed.
  const bundle = path.join(xaibo.home, 'diagnostics.json');
  await run.app!.evaluate(({ dialog, Menu }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as unknown as typeof dialog.showSaveDialog;
    Menu.getApplicationMenu()!.getMenuItemById('save-diagnostics')!.click();
  }, bundle);
  await expect.poll(() => { try { return statSync(bundle).size > 0; } catch { return false; } }).toBe(true);
  const parsed = JSON.parse(readFileSync(bundle, 'utf8')) as { health: { state: string }; logTail: string[] };
  expect(parsed.health.state).toBe('running');
  expect(parsed.logTail.some((l) => l.includes('uncaught_exception'))).toBe(true);
  expect(mode(bundle)).toBe(0o600);

  saveArtifact(testInfo.outputDir, 'canary-echo.txt', text); // a test helper writing content under test-results/

  expect(mode(run.dataDir)).toBe(0o700);
  expect(mode(db)).toBe(0o600);
  expect(mode(path.join(run.dataDir, 'logs'))).toBe(0o700);
  const logs = files(path.join(run.dataDir, 'logs'));
  for (const f of logs) expect(mode(f), path.basename(f)).toBe(0o600);
  const egress = [bundle, ...logs, ...files(testInfo.outputDir)];
  expect(egress.length).toBeGreaterThan(2);
  expect(egress.map((f) => [path.relative(xaibo.home, f), hits(f)]).filter(([, n]) => n)).toEqual([]);

  const dumps = await run.app!.evaluate(({ app }) => app.getPath('crashDumps'));
  expect(files(dumps).filter((f) => /\.(dmp|ips)$/.test(f))).toEqual([]);
});
