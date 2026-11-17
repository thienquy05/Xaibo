// P4-T15 (A11Y sweep; design §5.3, §5.4, §6.2, §6.3, §8.1, §8.3): keyboard only, narrow (720×640) and wide (1280×800):
// skip link → Dashboard view group → Needs attention → the record's Open session → the open session (header, the seven
// section buttons as a named selector group with Left/Right, Details drawer with Escape) → Return to Dashboard, which
// restores the same queue record. Every interactive element has a name; repeated Open session actions name their
// record; focus is visible (2 px solid accent outline, 2 px offset); aria snapshots per screen. No axe (Q-4.2).
// Synthetic ids and paths only.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { claudeProfile, deliver } from '../helpers/hook-socket.ts';
import { expect, test, type Xaibo } from './fixtures.ts';

const SID = '00000000-0000-4000-8000-0000000fa151';
const OTHER = '00000000-0000-4000-8000-0000000fa152';
const CWD = '/tmp/xaibo-fixture/a11y';
const LAYOUTS = { narrow: [720, 640], wide: [1280, 800] } as const;

function transcript(home: string, sid: string, cwd: string) {
  const dir = path.join(home, '.claude', 'projects', cwd.replaceAll('/', '-'));
  mkdirSync(dir, { recursive: true });
  const at = Date.now() - 10_000;
  const base = (type: string, i: number) => ({ parentUuid: null, isSidechain: false, type, uuid: `${sid.slice(0, -2)}${String(i).padStart(2, '0')}`,
    timestamp: new Date(at + i * 1000).toISOString(), userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.319' });
  writeFileSync(path.join(dir, `${sid}.jsonl`), [
    { ...base('user', 1), message: { role: 'user', content: 'Summarize the notes' } },
    { ...base('assistant', 2), message: { model: 'claude-opus-5-5', id: `msg_${sid.slice(-4)}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
}

/** XAIBO_SHOT=<dir>: screenshots for the visual check (off by default). */
const shot = async (page: Page, name: string) => { if (process.env.XAIBO_SHOT) await page.screenshot({ path: path.join(process.env.XAIBO_SHOT, `${name}.png`) }); };

/** Presses Tab until `target` has focus; fails if it is not reached within `max` presses (keyboard-only access). */
async function tabTo(page: Page, target: Locator, max = 120) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement, undefined, { timeout: 2000 })) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`not reachable by Tab: ${target.toString()}`);
}

/** Design §2.3/§5.1: focus shows a 2 px solid outline in the focus token with a 2 px offset (on the element or, for a
 *  virtual-list item, its first child). */
async function expectVisibleFocus(target: Locator) {
  await expect(target).toBeFocused();
  const ring = await target.evaluate((el) => {
    const pick = (e: Element) => { const s = getComputedStyle(e); return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, color: s.outlineColor }; };
    const own = pick(el);
    return own.style !== 'none' ? own : el.firstElementChild ? pick(el.firstElementChild) : own;
  });
  const focus = await target.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--x-focus').trim());
  expect(ring).toMatchObject({ style: 'solid', width: '2px', offset: '2px' });
  expect(focus, 'the focus token resolves').not.toBe('');
}

/** Every focusable control in the window has a non-empty accessible name. */
async function expectNamed(page: Page) {
  const controls = page.locator('button:visible, a[href]:visible, summary:visible, select:visible, input:visible, [tabindex="0"]:visible');
  const n = await controls.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const c = controls.nth(i);
    await expect(c, await c.evaluate((e) => e.outerHTML.slice(0, 160))).toHaveAccessibleName(/\S/);
  }
}

async function start(xaibo: Xaibo, layout: keyof typeof LAYOUTS, extra = 0) {
  xaibo.touchStore(() => { transcript(xaibo.home, SID, CWD); transcript(xaibo.home, OTHER, `${CWD}-other`); });
  const dataDir = path.join(path.dirname(xaibo.home), 'data-a11y'); // short: the socket path
  const run = await xaibo.launch({ dataDir });
  const page = await xaibo.window(run);
  const [w, h] = LAYOUTS[layout];
  await run.app!.evaluate(({ BrowserWindow }, [ww, hh]) => BrowserWindow.getAllWindows()[0]!.setSize(ww!, hh!), [w, h]);
  await expect(page.getByRole('status')).toContainText('Collection: Running', { timeout: 15_000 });
  let profile: string | null = null;
  await expect.poll(() => (profile = claudeProfile(dataDir)), { timeout: 15_000 }).toBeTruthy();
  await expect.poll(() => existsSync(path.join(dataDir, 'run', 'token')), { timeout: 15_000 }).toBe(true);
  const hook = async (sid: string, cwd: string, event: string, payload: Record<string, unknown> = {}) => {
    const ack = await deliver(dataDir, { v: 1, delivery_id: randomUUID(), agent: 'claude', profile_key: profile!, event, session_id: sid, cwd,
      received_ts: Date.now(), payload: { hook_event_name: event, session_id: sid, ...payload } });
    expect(ack).toMatchObject({ status: 'accepted' });
  };
  for (const [sid, cwd] of [[SID, CWD], [OTHER, `${CWD}-other`]] as const) {
    await hook(sid, cwd, 'SessionStart', { source: 'startup' });
    await hook(sid, cwd, 'UserPromptSubmit', { prompt: 'fixture prompt' });
  }
  for (let i = 0; i < extra; i++) { // hook-only live sessions, for a Live list longer than the window
    const sid = `00000000-0000-4000-8000-0000000fa2${String(i).padStart(2, '0')}`;
    await hook(sid, `${CWD}-n${i}`, 'SessionStart', { source: 'startup' });
    await hook(sid, `${CWD}-n${i}`, 'UserPromptSubmit', { prompt: 'fixture prompt' });
  }
  await hook(SID, CWD, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: `${CWD}/a` }, tool_use_id: 'w1' });
  await hook(SID, CWD, 'PermissionRequest', { tool_name: 'Write' });
  return page;
}

for (const layout of Object.keys(LAYOUTS) as (keyof typeof LAYOUTS)[]) {
  test(`${layout}: keyboard-only Dashboard → attention record → session sections → Details → Return to Dashboard`, async ({ xaibo }) => {
    test.setTimeout(90_000);
    const page = await start(xaibo, layout);
    const live = page.getByRole('list', { name: 'Live sessions' });
    await expect(live.getByRole('listitem')).toHaveCount(2, { timeout: 20_000 });

    // First Tab reveals Skip to main content (design §5.3)
    await page.locator('body').focus();
    await page.keyboard.press('Tab');
    await expectVisibleFocus(page.getByRole('link', { name: 'Skip to main content' }));

    // Repeated actions name their record (design §8.1): each live Open session names its agent and folder, uniquely
    const opens = live.getByRole('button', { name: /^Open session/ });
    await expect(opens).toHaveCount(2);
    const names = await opens.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent));
    expect(new Set(names).size, `distinct names: ${JSON.stringify(names)}`).toBe(2);
    for (const n of names) expect(n).toMatch(/^Open session: .+ · \/tmp\/xaibo-fixture\/a11y/);
    await expectNamed(page);

    // Dashboard view group: Tab to the pressed view, Right to Needs attention, Enter selects it
    const views = page.getByRole('group', { name: 'Dashboard view' });
    await tabTo(page, views.getByRole('button', { pressed: true }));
    await page.keyboard.press('ArrowRight');
    const attention = views.getByRole('button', { name: /^Needs attention 1$/ });
    await expectVisibleFocus(attention);
    await page.keyboard.press('Enter');
    await expect(attention).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#view-attention')).toMatchAriaSnapshot(`
      - heading "Needs attention" [level=2]
      - region "Confirmed requests":
        - heading "Confirmed requests" [level=3]
        - list "Confirmed requests":
          - listitem:
            - button /^Open session. Claude Code/
    `);

    await shot(page, `${layout}-attention`);
    // The attention record's Open session (design §6.2) opens the conversation and focuses its title (§5.3)
    const queueOpen = page.getByRole('list', { name: 'Confirmed requests' }).getByRole('button', { name: /^Open session: / });
    await tabTo(page, queueOpen);
    await expectVisibleFocus(queueOpen);
    await page.keyboard.press('Enter');
    await expect(page.locator('#open-session-title')).toBeFocused();
    const open = page.getByRole('region', { name: 'Untitled' }).or(page.locator('section.x-open'));
    await expect(open.getByRole('button', { name: 'Return to Dashboard' })).toBeVisible();
    await expect(page.locator('section.x-open .x-open-head')).toMatchAriaSnapshot(`
      - button "Return to Dashboard"
      - heading [level=2]
      - button "Details"
    `);
    await expectNamed(page);
    await shot(page, `${layout}-open-session`);

    // Session section: a named selector group; Left/Right move between its buttons, Enter shows the section (§8.1)
    const sections = page.getByRole('group', { name: 'Session section' });
    const names7 = ['Conversation', 'Timeline', 'Tools', 'Subagents', 'Files', 'Context', 'Cost'];
    await tabTo(page, sections.getByRole('button', { name: /^Conversation/ }));
    for (const [i, name] of names7.entries()) {
      const b = sections.getByRole('button', { name: new RegExp(`^${name}`) });
      await expectVisibleFocus(b);
      await page.keyboard.press('Enter');
      await expect(b).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
      if (i < names7.length - 1) await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('ArrowRight'); // bounded at the last, as the Dashboard view group
    await expect(sections.getByRole('button', { name: /^Cost/ })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(sections.getByRole('button', { name: /^Conversation/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText('Summarize the notes', { timeout: 20_000 });

    // Details drawer: Enter opens it with focus on Close details; Escape closes it and returns focus to Details (§5.4)
    const details = page.getByRole('button', { name: 'Details' });
    await tabTo(page, details);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Close details' })).toBeFocused();
    await expectNamed(page);
    await page.keyboard.press('Escape');
    await expect(details).toBeFocused();

    // Return to Dashboard restores the Needs attention view and the same record's Open session (§5.3, §6.2)
    const back = page.getByRole('button', { name: 'Return to Dashboard' });
    await tabTo(page, back);
    await expectVisibleFocus(back);
    await page.keyboard.press('Enter');
    await expect(views.getByRole('button', { name: /^Needs attention/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('list', { name: 'Confirmed requests' }).getByRole('button', { name: /^Open session: / })).toBeFocused();
  });
}

// review M1 (XAIBO-PROD-437): Return restores a Live record that was below the fold (its row was not mounted on return)
test('wide: Return to Dashboard restores a Live record below the fold', async ({ xaibo }) => {
  test.setTimeout(90_000);
  const page = await start(xaibo, 'wide', 10);
  const live = page.getByRole('list', { name: 'Live sessions' });
  await expect(live).toHaveAttribute('data-count', '12', { timeout: 20_000 });
  await tabTo(page, live.locator('li[tabindex="0"]'));
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab'); // into the focused record: its Open session
  const name = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
  expect(name).toMatch(/^Open session: /);
  await page.keyboard.press('Enter');
  await expect(page.locator('#open-session-title')).toBeFocused();
  await tabTo(page, page.getByRole('button', { name: 'Return to Dashboard' }));
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.id ?? '')).toBe(name);
});
