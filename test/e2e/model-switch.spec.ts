// XAIBO-PROD-420 (P4-T08b; EC-102 E, FR-51, US-19): mid-session model switches in the packaged app. Hook path: Codex
// hooks on the app socket (UserPromptSubmit with turn_id and model, as Codex 0.160.0 sends them); file-only path: Claude
// transcript appends (a prompt, then an assistant record with message.model). Each switch updates the list row and adds a
// timeline marker carrying the switch time; a subagent row shows its own model. Latency comes from the Phase 3 perf trace
// (service commit and delta, main paint ack on one monotonic clock): hook delivery -> paint <= M1 (250 ms), file append ->
// paint <= M2 (1 s). The observation hop (delivery or append -> commit) is reported apart from the total.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deliver } from '../helpers/hook-socket.ts';
import { ms, now, Trace } from '../perf/emitter.ts';
import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

const CODEX_SID = '00000000-0000-4000-8000-0000000e0b01';
const CLAUDE_SID = '00000000-0000-4000-8000-0000000e0b02';
const SUB = '00000000-0000-4000-8000-0000000e0b03';
const CODEX_CWD = '/tmp/xaibo-fixture/ms-codex';
const CLAUDE_CWD = '/tmp/xaibo-fixture/ms-claude';
const SWITCHES = 20; // per path: nearest-rank p95 of 20 is the 19th value, not the max
const M1 = 250, M2 = 1000;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-0000000e${String(++n).padStart(4, '0')}`;
const record = (type: 'user' | 'assistant', ts: number, extra: object, id = uuid()) => JSON.stringify({ parentUuid: null, isSidechain: false, type, uuid: id,
  timestamp: new Date(ts).toISOString(), userType: 'external', entrypoint: 'cli', cwd: CLAUDE_CWD, sessionId: CLAUDE_SID, version: '2.1.319', ...extra });
const prompt = (ts: number) => record('user', ts, { message: { role: 'user', content: 'Switch prompt' } });
const reply = (ts: number, model: string, id: string, extra: object = {}) => record('assistant', ts, { ...extra,
  message: { model, id: `msg_ms_${id.slice(-4)}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }, id);
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1]!;
const codexProfile = (dataDir: string) => {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
    return (db.prepare("SELECT id FROM profiles WHERE agent = 'codex'").get() as { id: string } | undefined)?.id ?? null;
  } catch { return null; } finally { db?.close(); }
};
// The Dashboard's Live sessions records carry the row's model field (the Session area list is compact).
const row = (page: Page, cwd: string) => page.getByRole('list', { name: 'Live sessions' }).getByRole('listitem').filter({ hasText: cwd });
const dashboard = (page: Page) => page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Dashboard' }).click();
const tab = (page: Page, name: string) => page.getByRole('group', { name: 'Session section' }).getByRole('button', { name: new RegExp(`^${name}`) });

test('switches on the hook path (M1) and the file-only path (M2) update row and timeline with their times; a subagent shows its own model', async ({ xaibo }) => {
  const project = path.join(xaibo.home, '.claude', 'projects', '-tmp-xaibo-fixture-ms-claude');
  const transcript = path.join(project, `${CLAUDE_SID}.jsonl`);
  const t0 = Date.now() - 60_000;
  const claudeTimes = [t0]; // the first turn (Opus) is the session's first model marker
  xaibo.touchStore(() => {
    mkdirSync(path.join(project, CLAUDE_SID, 'subagents'), { recursive: true });
    writeFileSync(transcript, `${prompt(t0)}\n${reply(t0 + 1, 'claude-opus-5-5', uuid())}\n`);
    writeFileSync(path.join(project, CLAUDE_SID, 'subagents', `agent-${SUB}.jsonl`), `${reply(t0 + 2, 'claude-haiku-5-5', uuid(), { isSidechain: true })}\n`);
  });
  const dataDir = path.join(path.dirname(xaibo.home), 'data-ms'); // short, for the socket path
  const run = await xaibo.launch({ dataDir, env: { XAIBO_PERF_TRACE: '1' } });
  const page = await xaibo.window(run);
  await expect(row(page, CLAUDE_CWD).locator('[data-field="model"]')).toHaveText('Claude Opus 5.5', { timeout: 20_000 });

  let profile: string | null = null;
  await expect.poll(() => (profile = codexProfile(dataDir)), { timeout: 15_000 }).toBeTruthy();
  await expect.poll(() => existsSync(path.join(dataDir, 'run', 'token')), { timeout: 15_000 }).toBe(true);
  const trace = new Trace(dataDir);
  const lat = { m1: [] as number[], m1Observe: [] as number[], m2: [] as number[], m2Observe: [] as number[] };

  // Hook path: a listed and an unlisted model in turn; Codex hooks expose no effort.
  const codexTimes: number[] = [];
  for (let i = 0; i < SWITCHES; i++) {
    const model = i % 2 ? 'gpt-6.1-sol-next' : 'gpt-6.1-sol', id = randomUUID(), ts = Date.now();
    codexTimes.push(ts);
    const start = now();
    const ack = await deliver(dataDir, { v: 1, delivery_id: id, agent: 'codex', profile_key: profile!, event: 'UserPromptSubmit', session_id: CODEX_SID, cwd: CODEX_CWD,
      received_ts: ts, payload: { hook_event_name: 'UserPromptSubmit', session_id: CODEX_SID, turn_id: randomUUID(), model, prompt: 'Switch prompt' } });
    expect(ack).toMatchObject({ status: 'accepted' });
    const j = await trace.join(id, 10_000, start);
    lat.m1.push(ms(start, j.paint));
    lat.m1Observe.push(ms(start, j.commit));
    await expect(row(page, CODEX_CWD).locator('[data-field="model"]')).toHaveText(i % 2 ? 'gpt-6.1-sol-next' : 'GPT-6.1 Sol');
  }

  // File-only path: Sonnet and Opus in turn, each a prompt then an assistant record carrying message.model.
  for (let i = 0; i < SWITCHES; i++) {
    const model = i % 2 ? 'claude-opus-5-5' : 'claude-sonnet-5-5', id = uuid(), ts = Date.now();
    claudeTimes.push(ts);
    const start = now();
    xaibo.touchStore(() => appendFileSync(transcript, `${prompt(ts)}\n${reply(ts + 1, model, id)}\n`));
    const j = await trace.join(id, 10_000, start);
    lat.m2.push(ms(start, j.paint));
    lat.m2Observe.push(ms(start, j.commit));
    await expect(row(page, CLAUDE_CWD).locator('[data-field="model"]')).toHaveText(i % 2 ? 'Claude Opus 5.5' : 'Claude Sonnet 5.5');
  }
  const round = (v: number) => Math.round(v * 10) / 10;
  const report = Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { n: v.length, p95: round(p95(v)), max: round(Math.max(...v)) }]));
  console.log(`model-switch latency (ms): ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: 'latency-ms', description: JSON.stringify(report) });
  expect(p95(lat.m1)).toBeLessThanOrEqual(M1);
  expect(p95(lat.m2)).toBeLessThanOrEqual(M2);

  // Timelines: one marker per switch, naming its model and carrying its switch time.
  const markersOf = async (cwd: string, expected: [string, number][]) => {
    await row(page, cwd).getByRole('button', { name: 'Open session' }).click();
    await tab(page, 'Timeline').click();
    const seq = page.getByRole('list', { name: 'Activity sequence' });
    // The list is virtualized (only visible rows mount): walk its scroller (VirtualList's viewport is the list's parent
    // element, as in workspace.spec.ts) from the top and collect every marker as [title, datetime], keyed by both.
    const collect = async () => {
      const seen = new Map<string, [string, string]>();
      await seq.evaluate((el) => { el.parentElement!.scrollTop = 0; });
      for (let i = 0; i < 200; i++) {
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const rows = await seq.getByRole('listitem').filter({ hasText: /Model / }).evaluateAll((els) =>
          els.map((e) => [e.querySelector('.x-l-title')?.textContent ?? '', e.querySelector('time')?.getAttribute('datetime') ?? ''] as [string, string]));
        for (const r of rows) seen.set(r.join('|'), r);
        if (await seq.evaluate((el) => { const s = el.parentElement!; const end = s.scrollTop + s.clientHeight >= s.scrollHeight - 1; s.scrollTop += s.clientHeight / 2; return end; })) break;
      }
      return [...seen.values()].sort((a, b) => a[1].localeCompare(b[1]));
    };
    await expect.poll(collect, { timeout: 30_000 }).toEqual(expected.map(([m, t]) => [`Model ${m}`, new Date(t).toISOString()]));
  };
  await markersOf(CODEX_CWD, codexTimes.map((t, i) => [i % 2 ? 'gpt-6.1-sol-next' : 'GPT-6.1 Sol', t]));
  await dashboard(page);
  await markersOf(CLAUDE_CWD, claudeTimes.map((t, i) => [i % 2 ? 'Claude Sonnet 5.5' : 'Claude Opus 5.5', t]));

  await tab(page, 'Subagents').click();
  await expect(page.getByRole('table', { name: 'Subagent records' }).getByRole('row').filter({ hasText: SUB })).toContainText('Claude Haiku 5.5');
});
