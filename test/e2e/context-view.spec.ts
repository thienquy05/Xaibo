// XAIBO-PROD-415 (P4-T06b; plan P4-T06 E; PRD FR-47, US-17; design §6.3.1): the Context tab on synthetic sessions.
// Claude without a statusLine window keeps its used tokens and no percentage; Claude after compaction shows Awaiting
// next usage and no meter; Codex shows its reported window with a meter; agy is unavailable. Category tables are
// always present and unavailable with the v1-B explanation.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, openSessions, seedCodexAgy, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

const PLAIN = { sid: '00000000-0000-4000-8000-00000000e000', cwd: '/tmp/xaibo-fixture/ctx-plain' };
const COMPACT = { sid: '00000000-0000-4000-8000-00000000e100', cwd: '/tmp/xaibo-fixture/ctx-compact' };
const at = (s: number) => `2026-01-03T11:00:${String(s).padStart(2, '0')}.000Z`;
let n = 0;
const base = (s: { sid: string; cwd: string }, type: string, sec: number) => ({ parentUuid: null, isSidechain: false, type,
  uuid: `00000000-0000-4000-8000-00000000e${String(++n).padStart(3, '0')}`, timestamp: at(sec), userType: 'external', entrypoint: 'cli',
  cwd: s.cwd, sessionId: s.sid, version: '2.1.319' });
const prompt = (s: typeof PLAIN, sec: number) => JSON.stringify({ ...base(s, 'user', sec), message: { role: 'user', content: 'Summarize the notes' } });
const reply = (s: typeof PLAIN, sec: number) => JSON.stringify({ ...base(s, 'assistant', sec), message: { model: 'claude-opus-5-5', id: `msg_ctx_${n}`,
  type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }],
  usage: { input_tokens: 1200, cache_read_input_tokens: 8000, cache_creation_input_tokens: 800, output_tokens: 50 } } });
const compaction = (s: typeof PLAIN, sec: number) => JSON.stringify({ ...base(s, 'system', sec), subtype: 'compact_boundary', content: 'fixture compaction',
  isMeta: false, level: 'info' });

function seed(home: string) {
  for (const [s, lines] of [[PLAIN, [prompt(PLAIN, 1), reply(PLAIN, 2)]], [COMPACT, [prompt(COMPACT, 1), reply(COMPACT, 2), compaction(COMPACT, 3)]]] as const) {
    const project = path.join(home, '.claude', 'projects', s.cwd.replaceAll('/', '-'));
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, `${s.sid}.jsonl`), lines.join('\n') + '\n');
  }
  seedCodexAgy(home);
}

const list = (page: Page) => page.getByRole('list', { name: 'Sessions' });
const openContext = async (page: Page, text: string) => {
  await expect(list(page).getByRole('button').filter({ hasText: text })).toHaveCount(1, { timeout: 20_000 });
  await list(page).getByRole('button').filter({ hasText: text }).first().click();
  await expect(page.locator('#open-session-title')).toBeFocused();
  await page.getByRole('group', { name: 'Session section' }).getByRole('button', { name: /^Context/ }).click();
  const body = page.getByRole('region', { name: 'Context' });
  await expect(body.getByRole('heading', { name: 'Current context' })).toBeVisible();
  return body;
};
const tables = async (body: ReturnType<Page['getByRole']>) => {
  for (const name of ['Used context', 'Outside used context', 'Deferred definitions']) await expect(body.getByRole('table', { name, exact: true })).toBeVisible();
  await expect(body.getByRole('cell', { name: /v1-B/ })).toHaveCount(11);
  // XAIBO-PROD-435: the row header says the name once; the cell speaks only the value
  await expect(body.getByRole('row', { name: 'Free space Unavailable — compaction buffer unavailable', exact: true })).toBeVisible();
  await expect(body).not.toContainText(/usable before compaction/i);
};

test('Context tab: Claude without a window, Claude after compaction, Codex with a meter, agy unavailable', async ({ xaibo }) => {
  xaibo.touchStore(() => seed(xaibo.home));
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  await openSessions(page);

  const plain = await openContext(page, PLAIN.cwd);
  await expect(plain).toContainText('10k used · window unavailable');
  await expect(plain.getByText('Context: percentage unavailable; 10,000 tokens used; window unavailable; source Claude transcript; generation 1')).toBeAttached();
  await expect(plain).toContainText('Context meter unavailable — window not reported (no statusLine window yet)');
  await expect(plain.getByRole('img', { name: /^Context meter/ })).toHaveCount(0);
  await expect(plain).not.toContainText(/\d%/);
  await tables(plain);

  const compact = await openContext(page, COMPACT.cwd);
  await expect(compact).toContainText('Awaiting next usage');
  await expect(compact).toContainText('Context meter unavailable — awaiting next usage after compaction');
  await expect(compact.getByRole('img', { name: /^Context meter/ })).toHaveCount(0);
  await expect(compact).toContainText('Generation 2'); // compaction started a new generation
  await expect(compact).not.toContainText('10k'); // the old reading is not shown as current

  const codex = await openContext(page, 'codex');
  await expect(codex).toContainText('0.6% · 1.2k / 200k');
  await expect(codex.getByText('Context: 0.6 percent; 1,200 of 200,000 tokens; source Codex rollout; generation 1')).toBeAttached();
  const meter = codex.getByRole('img', { name: 'Context meter: 0.6 percent used' });
  await expect(meter).toBeVisible();
  await expect(codex).toContainText('Unoccupied; buffer unknown');
  // review L: the used segment's width is applied in the packaged app under its CSP
  expect(await meter.locator('.x-meter-used').evaluate((e) => (e as HTMLElement).style.width)).toBe('0.6%');
  await expect(codex).toContainText('Source: Codex rollout');
  await tables(codex);

  const agy = await openContext(page, 'agy');
  await expect(agy).toContainText('Context unavailable');
  await expect(agy).toContainText('Antigravity CLI context inputs and window are unverified');
  await expect(agy.getByRole('img', { name: /^Context meter/ })).toHaveCount(0);
  await expect(agy).not.toContainText(/\d%/);
});
