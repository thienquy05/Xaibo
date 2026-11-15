// XAIBO-PROD-413 (P4-T05d; plan P4-T05 E; design §6.3 as amended by D-P4-06): the Session workspace on synthetic
// Claude, Codex and Antigravity sessions: turns, tools with results, a subagent, the three file-touch kinds, the
// reasoning block and the Content incomplete label; fixed frame, Details drawer and section tabs.
import { copyFileSync, cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { visible } from '../../src/renderer/text.ts';
import { REPO, expect, openSessions, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

const SID = '00000000-0000-4000-8000-00000000d000';
const SUB = '00000000-0000-4000-8000-00000000d100';
const CWD = '/tmp/xaibo-fixture/ws-claude';
// Review gap: hostile prompt, tool name, input and result must reach the screen only as escaped text (EC-55).
const EVIL_PROMPT = '<script>window.__xss=1</script>\u202Edrow sdrawkcab \u001b[31mred';
const EVIL_NAME = 'Bash<img src=x onerror="window.__xss=1">\u202E';
const EVIL_RESULT = '<b>bold</b> \u001b[2J cleared \u2066isolate\u2069';
const at = (s: number) => `2026-01-03T10:00:${String(s).padStart(2, '0')}.000Z`;
let n = 0;
const rec = (type: 'user' | 'assistant', content: unknown, s: number, extra: object = {}) => JSON.stringify({
  parentUuid: null, isSidechain: false, type, uuid: `00000000-0000-4000-8000-00000000d${String(++n).padStart(3, '0')}`, timestamp: at(s), userType: 'external',
  entrypoint: 'cli', cwd: CWD, sessionId: SID, version: '2.1.319',
  message: type === 'user' ? { role: 'user', content } : { model: 'claude-opus-5-5', id: `msg_ws_${n}`, type: 'message', role: 'assistant', content }, ...extra,
});
const use = (id: string, name: string, input: object) => [{ type: 'tool_use', id, name, input }];
const result = (id: string, text: string) => [{ type: 'tool_result', tool_use_id: id, content: text, is_error: false }];

function seed(home: string) {
  const project = path.join(home, '.claude', 'projects', '-tmp-xaibo-fixture-ws-claude');
  mkdirSync(path.join(project, SID, 'subagents'), { recursive: true });
  writeFileSync(path.join(project, `${SID}.jsonl`), [
    rec('user', 'Fix the trailing comma bug', 1),
    rec('assistant', [{ type: 'thinking', thinking: 'Plan: read the parser first', signature: 'sig' }, { type: 'text', text: 'Reading the parser.' }], 2),
    rec('assistant', use('toolu_ws_read', 'Read', { file_path: `${CWD}/parse.ts` }), 3),
    rec('user', result('toolu_ws_read', 'export const split = 1'), 4),
    rec('assistant', use('toolu_ws_write', 'Write', { file_path: `${CWD}/out.ts`, content: 'x' }), 5),
    rec('user', result('toolu_ws_write', 'File written'), 6),
    rec('assistant', use('toolu_ws_edit', 'Edit', { file_path: `${CWD}/parse.ts`, old_string: 'a', new_string: 'b' }), 7),
    rec('user', EVIL_PROMPT, 10),
    rec('assistant', use('toolu_ws_evil', EVIL_NAME, { command: '<b>x</b>' }), 11),
    rec('user', result('toolu_ws_evil', EVIL_RESULT), 12),
    '{not valid json', // quarantined: Content incomplete
  ].join('\n') + '\n');
  writeFileSync(path.join(project, SID, 'subagents', `agent-${SUB}.jsonl`), [
    rec('user', 'Check the tests', 8, { isSidechain: true }),
    JSON.stringify({ ...JSON.parse(rec('assistant', [{ type: 'text', text: 'Tests pass.' }], 9, { isSidechain: true })),
      message: { model: 'claude-haiku-fixture', id: 'msg_ws_sub', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Tests pass.' }] } }),
  ].join('\n') + '\n');
  const codex = path.join(home, '.codex', 'sessions', '2026', '01', '01');
  mkdirSync(codex, { recursive: true });
  const fixture = path.join(REPO, 'test', 'fixtures', 'synthetic', 'codex', '0.160.0', 'simple-turn');
  const name = readdirSync(fixture).find((f) => f.startsWith('rollout-'))!;
  copyFileSync(path.join(fixture, name), path.join(codex, name));
  cpSync(path.join(REPO, 'test', 'fixtures', 'synthetic', 'agy', '1.5.6', 'basic', 'brain'), path.join(home, '.gemini', 'antigravity-cli', 'brain'), { recursive: true });
}

const list = (page: Page) => page.getByRole('list', { name: 'Sessions' });
const open = async (page: Page, text: string | RegExp) => {
  await list(page).getByRole('button').filter({ hasText: text }).first().click();
  await expect(page.locator('#open-session-title')).toBeFocused();
};
const tab = (page: Page, name: string) => page.getByRole('group', { name: 'Session section' }).getByRole('button', { name: new RegExp(`^${name}`) });

test('Claude session: conversation, reasoning, tools, subagent, files, timeline, coverage and details', async ({ xaibo }) => {
  xaibo.touchStore(() => seed(xaibo.home));
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  await openSessions(page);
  await expect(list(page).getByRole('button').filter({ hasText: CWD })).toHaveCount(1, { timeout: 20_000 });
  await open(page, CWD);

  const convo = page.getByRole('list', { name: 'Conversation' });
  await expect(convo).toContainText('Owner prompt');
  await expect(convo).toContainText('Fix the trailing comma bug');
  await expect(convo).toContainText('Reading the parser.');
  await expect(page.getByText('Content incomplete', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.x-gap')).toContainText('Some records could not be read');

  // Reasoning stays collapsed until expanded, then its text is fetched.
  await expect(convo).not.toContainText('Plan: read the parser first');
  await convo.locator('summary', { hasText: 'Available reasoning' }).click();
  await expect(convo).toContainText('Plan: read the parser first');

  // Each tool once, as a compact row with its file; expanding fetches input and result.
  const read = convo.locator('summary').filter({ hasText: 'Read' }).filter({ hasText: `${CWD}/parse.ts` });
  await expect(read).toHaveCount(1);
  await read.click();
  await expect(convo).toContainText('Result · Completed');
  await expect(convo).toContainText('export const split = 1');
  await expect(convo.locator('summary').filter({ hasText: 'Edit' })).toContainText('Duration unavailable');
  // The conversation is virtualized: scroll its own scroller to the end so the later records mount.
  const toEnd = async (l: typeof convo) => { await l.evaluate((el) => { const s = el.parentElement!; s.scrollTop = s.scrollHeight; }); return (await l.textContent()) ?? ''; };
  await expect.poll(() => toEnd(convo)).toContain(visible(EVIL_PROMPT));
  await convo.locator('summary').filter({ hasText: visible(EVIL_NAME) }).click();
  await expect(convo).toContainText(visible(EVIL_RESULT));
  expect(await page.locator('main b, main img, main script').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();

  await tab(page, 'Tools').click();
  const tools = page.getByRole('table', { name: 'Tool ledger' });
  await expect(tools.getByRole('row')).toHaveCount(5); // header + Read, Write, Edit, hostile Bash
  await expect(tools).toContainText(visible(EVIL_NAME));
  await expect(tools.getByRole('row').filter({ hasText: 'Write' })).toContainText('Completed');
  await expect(tools.getByRole('row').filter({ hasText: 'Edit' })).toContainText('Result unavailable');

  await tab(page, 'Subagents').click();
  await expect(page.getByRole('table', { name: 'Subagent records' }).getByRole('row').nth(1)).toContainText('claude-haiku-fixture');

  await tab(page, 'Files').click();
  const files = page.getByRole('table', { name: 'Files touched' });
  await expect(files.getByRole('row').filter({ hasText: `${CWD}/parse.ts` })).toContainText('Read');
  await expect(files.getByRole('row').filter({ hasText: `${CWD}/parse.ts` })).toContainText('Write attempted');
  await expect(files.getByRole('row').filter({ hasText: `${CWD}/out.ts` })).toContainText('Write confirmed');

  await tab(page, 'Timeline').click();
  await expect(page.getByRole('list', { name: 'Activity sequence' })).toContainText('Tool call — Read');
  await expect.poll(() => toEnd(page.getByRole('list', { name: 'Activity sequence' }))).toContain(`Tool call — ${visible(EVIL_NAME)}`);
  expect(await page.locator('main b, main img, main script').count()).toBe(0);

  // Details drawer: opens over the body, Escape closes it and returns focus to the toggle.
  const details = page.getByRole('button', { name: 'Details' });
  await details.click();
  await expect(page.locator('#session-details')).toBeVisible();
  await expect(page.locator('#session-details')).toContainText(CWD);
  await page.keyboard.press('Escape');
  await expect(page.locator('#session-details')).toBeHidden();
  await expect(details).toBeFocused();

  // Fixed frame: the page itself never scrolls in the Session area.
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight + 1)).toBe(true);
  // The session list can be hidden and shown again.
  await page.getByRole('button', { name: 'Hide session list' }).click();
  await expect(list(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Show session list' }).click();
  await expect(list(page)).toBeVisible();
});

test('Codex and Antigravity sessions: turns and tools with results', async ({ xaibo }) => {
  xaibo.touchStore(() => seed(xaibo.home));
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  await openSessions(page);
  await expect(list(page).getByRole('button').filter({ hasText: 'codex' })).toHaveCount(1, { timeout: 20_000 });
  await open(page, 'codex');
  const convo = page.getByRole('list', { name: 'Conversation' });
  await expect(convo).toContainText('synthetic prompt');
  await tab(page, 'Tools').click();
  await expect(page.getByRole('table', { name: 'Tool ledger' }).getByRole('row')).toHaveCount(2);

  await expect(list(page).getByRole('button').filter({ hasText: 'agy' })).toHaveCount(1, { timeout: 20_000 });
  await open(page, 'agy');
  await expect(page.getByRole('list', { name: 'Conversation' })).toContainText('Read the fixture notes file');
  await tab(page, 'Tools').click();
  await expect(page.getByRole('table', { name: 'Tool ledger' })).toContainText('read_file');
});
