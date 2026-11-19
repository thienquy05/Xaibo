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
// P4-T15b (D-P4-11, Claude + Codex; design §2.4, §8.1, §8.3): text-spacing overrides, 320 CSS px reflow and 200% text,
// both themes, per screen: no page or scrollport overflow, no clipped text, no overlapping controls, every Tab stop with
// its focus ring 4 px clear of clipping ancestors and sticky bars; no console errors. Geometry is evidence, not
// certification: screenshots (XAIBO_SHOT) get a human look.
type Theme = 'light' | 'dark';
type Mode = 'normal' | 'reflow' | 'text200';
/** §2.4: line height 1.5× font size, paragraph spacing 2×, letter spacing 0.12em, word spacing 0.16em, together. */
const SPACING = ['* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }', 'p { margin-bottom: 2em !important; }'];

/** Adds rules to the app's own same-origin stylesheet through the CSSOM (§2.4; the CSP allows no inline style). */
async function addRules(page: Page, rules: string[]) {
  await page.evaluate((rs) => {
    const sheet = [...document.styleSheets].find((x) => { try { return x.cssRules.length >= 0; } catch { return false; } })!;
    for (const r of rs) sheet.insertRule(r, sheet.cssRules.length);
  }, rules);
}

/** Layout problems on the current screen: page or scrollport overflow, clipped text, overlapping visible controls. */
async function layoutProblems(page: Page, where: string): Promise<string[]> {
  return page.evaluate((where) => {
    const out: string[] = [];
    const desc = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.trim().split(/\s+/).join('.')}` : ''}`;
    const hidden = (e: Element) => !!e.closest('[inert], [hidden], .x-sr-only, svg') || getComputedStyle(e).visibility === 'hidden';
    const clipRect = (e: Element) => { // the part of e not clipped by its scrollports and the window
      let r = e.getBoundingClientRect();
      let { left, top, right, bottom } = r;
      for (let a = e.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        r = a.getBoundingClientRect();
        left = Math.max(left, r.left); top = Math.max(top, r.top); right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
      }
      return { left: Math.max(left, 0), top: Math.max(top, 0), right: Math.min(right, innerWidth), bottom: Math.min(bottom, innerHeight) };
    };
    const d = document.documentElement;
    if (d.scrollWidth > d.clientWidth + 1) out.push(`${where}: the page scrolls horizontally (${d.scrollWidth} > ${d.clientWidth})`);
    for (const e of document.querySelectorAll('body *')) {
      if (hidden(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(e);
      if (s.overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1) out.push(`${where}: horizontal overflow in ${desc(e)} (${e.scrollWidth} > ${e.clientWidth})`);
      if ((s.overflowY === 'hidden' || s.overflowY === 'clip') && e.scrollHeight > e.clientHeight + 1) out.push(`${where}: text clipped vertically in ${desc(e)}`);
    }
    const ctrls = [...document.querySelectorAll('button, a[href], input, select, summary')].filter((e) => !hidden(e)).map((e) => ({ e, c: clipRect(e) }))
      .filter((x) => x.c.right - x.c.left > 1 && x.c.bottom - x.c.top > 1)
      .filter((x) => { const h = document.elementFromPoint((x.c.left + x.c.right) / 2, (x.c.top + x.c.bottom) / 2); return !!h && (x.e === h || x.e.contains(h)); });
    for (let i = 0; i < ctrls.length; i++) {
      for (let j = i + 1; j < ctrls.length; j++) {
        const a = ctrls[i]!, b = ctrls[j]!;
        if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
        // content scrolled under a sticky or fixed bar is by design, not an overlap
        const pinned = (e: Element) => { for (let x: Element | null = e; x; x = x.parentElement) if (['sticky', 'fixed'].includes(getComputedStyle(x).position)) return true; return false; };
        if (pinned(a.e) !== pinned(b.e)) continue;
        const w = Math.min(a.c.right, b.c.right) - Math.max(a.c.left, b.c.left);
        const h = Math.min(a.c.bottom, b.c.bottom) - Math.max(a.c.top, b.c.top);
        if (w > 1 && h > 1) out.push(`${where}: ${desc(a.e)} "${a.e.textContent?.trim().slice(0, 30)}" overlaps ${desc(b.e)} "${b.e.textContent?.trim().slice(0, 30)}"`);
      }
    }
    return out;
  }, where);
}

/** Walks Tab from the current focus (at most `max` stops): each stop's ring-bearing box plus 4 px must sit inside every
 *  clipping ancestor and the window, and no sticky or fixed bar outside it may cover it (§2.3). */
async function focusProblems(page: Page, where: string, max = 60): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  let first: string | null = null;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { key: 'body', problem: null as string | null };
      const desc = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.trim().split(/\s+/).join('.')}` : ''}`;
      const ring = getComputedStyle(el).outlineStyle !== 'none' ? el : (el.firstElementChild ?? el);
      const rs = getComputedStyle(ring);
      const grow = Math.max(0, parseFloat(rs.outlineWidth) + parseFloat(rs.outlineOffset)); // an inset ring needs no outside room
      const b = ring.getBoundingClientRect();
      const need = { left: b.left - grow, top: b.top - grow, right: b.right + grow, bottom: b.bottom + grow };
      const key = `${desc(el)}|${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40)}`;
      // a control larger than its clipping box in one dimension cannot show its whole ring there; that dimension is skipped
      const outside = (c: { left: number; top: number; right: number; bottom: number }) =>
        (need.right - need.left <= c.right - c.left && (need.left < c.left || need.right > c.right))
        || (need.bottom - need.top <= c.bottom - c.top && (need.top < c.top || need.bottom > c.bottom));
      // XAIBO-PROD-509: the same skip for the window when a clipping ancestor is already smaller than the ring box in that
      // dimension (a record taller than its list scroller at 200 % text): the ring is cut there whatever the window shows
      const clips: DOMRect[] = [];
      for (let a = ring.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') clips.push(a.getBoundingClientRect());
      }
      // XAIBO-PROD-525: the same for a record taller than the window below the sticky top band (frame-pad scroll padding
      // and 8 px scroll margin above, 8 px below): no scroll position shows its whole ring (a 466 px row at 200 % text
      // under a wrapped navigation band). The leading rail (>= 1200 px) is not a top band.
      const band = document.querySelector('.x-frame')!.getBoundingClientRect();
      const under = band.width >= innerWidth - 1 ? innerHeight - band.bottom - 16 : innerHeight;
      const tooWide = clips.some((c) => need.right - need.left > c.width), tooTall = need.bottom - need.top > under || clips.some((c) => need.bottom - need.top > c.height);
      const win = { left: tooWide ? need.left : 0, top: tooTall ? need.top : 0, right: tooWide ? need.right : innerWidth, bottom: tooTall ? need.bottom : innerHeight };
      if (outside(win)) return { key, problem: `${key}: focus ring within 4 px of the window edge` };
      // review M1: in a skipped dimension the control must still be in view (overlap the window and every clipping box)
      const vis = clips.reduce((v, c) => ({ left: Math.max(v.left, c.left), top: Math.max(v.top, c.top), right: Math.min(v.right, c.right), bottom: Math.min(v.bottom, c.bottom) }),
        { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
      if ((tooTall && (need.bottom <= vis.top || need.top >= vis.bottom)) || (tooWide && (need.right <= vis.left || need.left >= vis.right))) {
        return { key, problem: `${key}: focused control out of view` };
      }
      for (let a = ring.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        // a skipped dimension is skipped for a clipping box only when the ring cannot fit in its part visible below the top
        // band either (re-review LOW-1: a box with room still catches a cut ring, e.g. lost scroll padding)
        const c = a.getBoundingClientRect();
        const room = Math.min(c.bottom, innerHeight) - Math.max(c.top, band.width >= innerWidth - 1 ? band.bottom + 8 : 0);
        const skipY = tooTall && need.bottom - need.top > room;
        if (outside({ left: tooWide ? need.left : c.left, right: tooWide ? need.right : c.right, top: skipY ? need.top : c.top, bottom: skipY ? need.bottom : c.bottom })) {
          return { key, problem: `${key}: focus ring clipped by ${desc(a)}` };
        }
      }
      // covered: something else is drawn over the control itself (an outline cannot be hit-tested, its box can)
      const box = el.getBoundingClientRect();
      const ix = Math.min(12, box.width / 4), iy = Math.min(12, box.height / 4); // inside rounded corners
      // centre and top-left only: the right edge of a scroller holds the macOS overlay scrollbar, which hit-tests as the scroller
      for (const [x, y] of [[(box.left + box.right) / 2, (box.top + box.bottom) / 2], [box.left + ix, box.top + iy]] as [number, number][]) {
        const h = document.elementFromPoint(x, y);
        if (h && h !== el && !el.contains(h)) return { key, problem: `${key}: covered by ${desc(h)}` };
      }
      return { key, problem: null };
    });
    if (r.key === first) break; // back at the start of the cycle (review M: not at the first repeated name)
    first ??= r.key;
    if (seen.has(r.key)) continue; // a same-named control already checked
    seen.add(r.key);
    if (r.problem) out.push(`${where}: ${r.problem}`);
  }
  return out;
}

async function setTheme(app: import('@playwright/test').ElectronApplication, page: Page, theme: Theme) {
  await page.emulateMedia({ colorScheme: null }); // no Playwright override: the OS appearance (nativeTheme) decides
  await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark');
}

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
      // D-P5-11 (owner, 2026-11-19; P5-T18 part 3a): at 200 % text in 960×640 a Tab-focused Session list record can sit
      // partly under the sticky top band (seen in every Session stage); fixed first in part 3b.
      const KNOWN = mode === 'reflow' ? [/^session-[a-z]+: button\.x-btn\.x-btn-primary\|Go to latest: focus ring clipped by section\.x-pane\.x-open$/]
        : mode === 'text200' ? [/^session-[a-z]+: button\.x-srow\|[^:]*: covered by a$/] : [];
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
