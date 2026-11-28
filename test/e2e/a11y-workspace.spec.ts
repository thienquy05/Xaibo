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
import { addRules, focusProblems, layoutProblems, setTheme, SPACING, type Mode, type Theme } from './a11y-checks.ts';
import { expect, shot, tabTo, test, type Xaibo } from './fixtures.ts';

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
  const hook = async (sid: string, cwd: string | null, event: string, payload: Record<string, unknown> = {}) => {
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
  // a statusLine reading: usage scopes with rate limits and Observed history (P4-T15b)
  await hook(SID, null, 'statusline', { session_id: SID, model: { id: 'claude-opus-5-5', display_name: 'Synthetic Opus' }, cost: { total_cost_usd: 0.42 },
    context_window: { context_window_size: 200000, current_usage: { input_tokens: 1200, output_tokens: 50, cache_creation_input_tokens: 800, cache_read_input_tokens: 8000 } },
    rate_limits: { five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { used_percentage: 9, resets_at: Math.floor(Date.now() / 1000) + 5 * 86400 } } });
  return { page, app: run.app! };
}

for (const layout of Object.keys(LAYOUTS) as (keyof typeof LAYOUTS)[]) {
  test(`${layout}: keyboard-only Dashboard → attention record → session sections → Details → Return to Dashboard`, async ({ xaibo }) => {
    test.setTimeout(90_000);
    const { page } = await start(xaibo, layout);
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
  const { page } = await start(xaibo, 'wide', 10);
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

// ---------------------------------------------------------------------------------------------------------------
// P4-T15b (D-P4-11, Claude + Codex; design §2.4, §8.1, §8.3): the checks live in a11y-checks.ts (shared with the P6-T10a
// sign-in surfaces); both themes, per screen; no console errors.
for (const theme of ['light', 'dark'] as Theme[]) {
  for (const mode of ['normal', 'reflow', 'text200'] as Mode[]) {
    test(`T15b ${theme} × ${mode}: text-spacing overrides, no overflow, clipping, overlap or clipped focus rings`, async ({ xaibo }) => {
      test.setTimeout(180_000);
      const { page, app } = await start(xaibo, mode === 'reflow' ? 'narrow' : 'wide', 10);
      const errors: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await setTheme(app, page, theme);
      const live = page.getByRole('list', { name: 'Live sessions' });
      await expect(live).toHaveAttribute('data-count', '12', { timeout: 20_000 });
      if (mode === 'reflow') {
        await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(640, 560); w.webContents.setZoomFactor(2); });
        await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(320);
      } else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 640));
      const font = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.x-band-text')!).fontSize));
      const before = await font();
      if (mode === 'text200') {
        await addRules(page, ['html { font-size: 200% !important; }']);
        expect(await font(), 'text-only 200%: the band text doubles').toBeCloseTo(before * 2, 0);
      }
      await addRules(page, SPACING);
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      test.info().annotations.push({ type: 'css-viewport', description: JSON.stringify(viewport) });
      // a fixture-only fifth Areas link proves the navigation wraps (§8.1); no product destination is added
      await page.evaluate(() => { const nav = document.querySelector('nav[aria-label="Areas"]')!; const a = document.createElement('a'); a.href = '#fixture'; a.textContent = 'Fixture link'; nav.append(a); });

      const problems: string[] = [];
      const check = async (where: string) => {
        if (process.env.XAIBO_SHOT) await page.screenshot({ path: path.join(process.env.XAIBO_SHOT, `t15b-${theme}-${mode}-${where}.png`) });
        problems.push(...await layoutProblems(page, where));
        await page.locator('body').focus();
        problems.push(...await focusProblems(page, where));
      };
      const views = page.getByRole('group', { name: 'Dashboard view' });
      await check('dashboard-live');
      await views.getByRole('button', { name: /^Needs attention/ }).click();
      await check('dashboard-attention');
      await views.getByRole('button', { name: 'Usage and history' }).click();
      const claude = page.getByRole('region', { name: /^Claude Code · / }).first();
      await expect(claude).toBeVisible({ timeout: 15_000 });
      await expect(claude.getByRole('button', { name: 'Observed history' }).first()).toHaveAttribute('aria-expanded', 'true'); // open by default
      await check('dashboard-usage-history');
      await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Session', exact: true }).click();
      await check('session-list');
      await page.getByRole('list', { name: 'Sessions' }).getByRole('button').filter({ hasText: `${CWD}` }).first().click();
      const sections = page.getByRole('group', { name: 'Session section' });
      for (const name of ['Conversation', 'Context', 'Cost']) {
        await sections.getByRole('button', { name: new RegExp(`^${name}`) }).click();
        await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
        await check(`session-${name.toLowerCase()}`);
      }
      await page.getByRole('button', { name: 'Details' }).click();
      await expect(page.getByRole('button', { name: 'Close details' })).toBeVisible();
      await check('session-details');
      expect(errors, 'console errors').toEqual([]);
      // Known, recorded in docs/plans/xaibo_progress.md (P4-T15b open item): at 320 CSS px the pane's last control's ring
      // touches the pane edge after focus scrolling, though the pane has 8 px scroll padding. Anything else fails.
      // XAIBO-PROD-627: the same known edge at 200 % text, now that the header carries Resume / Fork (a taller header leaves the
      // footer at the pane edge after focus scrolling); recorded with the P4-T15b open item for the MVP Gate
      const KNOWN = mode === 'reflow' ? [/^session-[a-z]+: button\.x-btn\.x-btn-primary\|Go to latest: focus ring clipped by section\.x-pane\.x-open$/]
        : mode === 'text200' ? [/^session-(?:conversation|cost): button\.x-btn\.x-btn-(?:primary|secondary)\|Go to (?:latest|first turn): focus ring clipped by section\.x-pane\.x-open$/] : [];
      const open = problems.filter((p) => !KNOWN.some((k) => k.test(p)));
      expect(open, `layout and focus problems at ${JSON.stringify(viewport)}`).toEqual([]);
    });
  }
}

test('T15b: aria snapshots of Live sessions and Usage and history (Observed history open)', async ({ xaibo }) => {
  test.setTimeout(90_000);
  const { page } = await start(xaibo, 'wide');
  await expect(page.getByRole('list', { name: 'Live sessions' }).getByRole('listitem')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator('#view-live')).toMatchAriaSnapshot(`
    - /children: contain
    - region "Live sessions":
      - heading "Live sessions" [level=2]
      - list "Live sessions":
        - listitem /^Untitled · Summarize the notes · claude · \\/tmp\\/xaibo-fixture\\/a11y/:
          - article:
            - button /^Open session. claude · \\/tmp\\/xaibo-fixture\\/a11y/
  `);
  const views = page.getByRole('group', { name: 'Dashboard view' });
  await views.getByRole('button', { name: 'Usage and history' }).click();
  const claude = page.getByRole('region', { name: /^Claude Code · / }).first();
  await expect(claude).toBeVisible({ timeout: 15_000 }); // the selected scope's Observed history is open by default
  await expect(page.locator('#view-usage')).toMatchAriaSnapshot(`
    - /children: contain
    - region "Usage and history":
      - heading "Usage and history" [level=2]
      - combobox "Usage scope and window"
      - region /^Claude Code · /:
        - heading /^Claude Code · / [level=3]
        - button "Observed history" [expanded]
  `);
});

test('T15b: focus and anchor survive the spacing overrides re-measuring rows (a scrolled virtual record)', async ({ xaibo }) => {
  test.setTimeout(90_000);
  const { page } = await start(xaibo, 'wide', 10);
  const live = page.getByRole('list', { name: 'Live sessions' });
  await expect(live).toHaveAttribute('data-count', '12', { timeout: 20_000 });
  await tabTo(page, live.locator('li[tabindex="0"]'));
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
  const key = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  expect(key).toBeTruthy();
  const inView = () => page.evaluate(() => { const r = document.activeElement!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  expect(await inView(), 'arrow-key focus brings the record into the window, not only into its list').toBe(true);
  await addRules(page, SPACING);
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(key);
  await expect.poll(inView, { message: 'the focused record stays in view after re-measurement' }).toBe(true);
});
