// P4-T16 (plan P4-T16; design §2.4 D10, §6.13; PRD §9.3 visual baselines; Q-4.1): toHaveScreenshot per screen —
// Dashboard (Live sessions, Needs attention), Session (each of the seven sections and the Details drawer) — at the
// design's outer sizes 960×640, 720×640, 640×560 and 1280×800 in light and dark, plus the empty, loading, error, stale,
// unavailable and estimate states at 960×640. Synthetic data only; animations off, 1× (scale: css), system fonts,
// darwin-only baselines in visual.spec.ts-snapshots/. Times that follow the real clock are masked.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { claudeProfile, deliver } from '../helpers/hook-socket.ts';
import { expect, openSessions, servicePid, test, type Xaibo } from './fixtures.ts';

test.skip(process.platform !== 'darwin', 'baselines are darwin-only (Q-4.1)');

const SID = '00000000-0000-4000-8000-0000000fb000';
const SUB = '00000000-0000-4000-8000-0000000fb100';
const OTHER = '00000000-0000-4000-8000-0000000fb001';
const CWD = '/tmp/xaibo-fixture/visual';
const SIZES = [[960, 640], [720, 640], [640, 560], [1280, 800]] as const;
const THEMES = ['light', 'dark'] as const;
const SECTIONS = ['Conversation', 'Timeline', 'Tools', 'Subagents', 'Files', 'Context', 'Cost'] as const;

let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 0, 3, 10, 0, s)).toISOString();
const rec = (sid: string, type: 'user' | 'assistant', content: unknown, s: number, extra: object = {}) => JSON.stringify({
  parentUuid: null, isSidechain: false, type, uuid: `00000000-0000-4000-8000-0000000fb${String(++n).padStart(3, '0')}`, timestamp: at(s), userType: 'external',
  entrypoint: 'cli', cwd: sid === OTHER ? `${CWD}-other` : CWD, sessionId: sid, version: '2.1.319',
  message: type === 'user' ? { role: 'user', content } : { model: 'claude-opus-5-5', id: `msg_vis_${n}`, type: 'message', role: 'assistant', content,
    usage: { input_tokens: 1200, cache_read_input_tokens: 8000, cache_creation_input_tokens: 800, output_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 800, ephemeral_1h_input_tokens: 0 }, service_tier: 'standard', speed: 'standard' } },
  ...extra,
});
const use = (id: string, name: string, input: object) => [{ type: 'tool_use', id, name, input }];
const result = (id: string, text: string) => [{ type: 'tool_result', tool_use_id: id, content: text, is_error: false }];

/** A complete Claude session: prompt, reasoning, reply, Read/Write/Edit tools with results and one subagent. */
function seed(home: string) {
  const project = path.join(home, '.claude', 'projects', CWD.replaceAll('/', '-'));
  mkdirSync(path.join(project, SID, 'subagents'), { recursive: true });
  writeFileSync(path.join(project, `${SID}.jsonl`), [
    rec(SID, 'user', 'Fix the trailing comma bug in the parser', 1),
    rec(SID, 'assistant', [{ type: 'thinking', thinking: 'Plan: read the parser first', signature: 'sig' }, { type: 'text', text: 'Reading the parser.' }], 2),
    rec(SID, 'assistant', use('toolu_vis_read', 'Read', { file_path: `${CWD}/parse.ts` }), 3),
    rec(SID, 'user', result('toolu_vis_read', 'export const split = (s: string) => s.split(",");'), 4),
    rec(SID, 'assistant', use('toolu_vis_write', 'Write', { file_path: `${CWD}/out.ts`, content: 'export {};' }), 5),
    rec(SID, 'user', result('toolu_vis_write', 'File written'), 6),
    rec(SID, 'assistant', use('toolu_vis_edit', 'Edit', { file_path: `${CWD}/parse.ts`, old_string: 'split(",")', new_string: 'split(",").filter(Boolean)' }), 7),
    rec(SID, 'user', result('toolu_vis_edit', 'Edit applied'), 8),
    rec(SID, 'assistant', [{ type: 'text', text: 'The parser now drops the empty field after a trailing comma.' }], 11),
  ].join('\n') + '\n');
  writeFileSync(path.join(project, SID, 'subagents', `agent-${SUB}.jsonl`), [
    rec(SID, 'user', 'Run the parser tests', 9, { isSidechain: true }),
    rec(SID, 'assistant', [{ type: 'text', text: 'All parser tests pass.' }], 10, { isSidechain: true }),
  ].join('\n') + '\n');
  const other = path.join(home, '.claude', 'projects', `${CWD}-other`.replaceAll('/', '-'));
  mkdirSync(other, { recursive: true });
  writeFileSync(path.join(other, `${OTHER}.jsonl`), [rec(OTHER, 'user', 'Summarize the notes', 1), rec(OTHER, 'assistant', [{ type: 'text', text: 'Done.' }], 2)].join('\n') + '\n');
}

/** The newest context reading's as_of for a session (read-only store poll); null until there is one. */
function lastContext(dataDir: string, sid: string): number | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
    const row = db.prepare('SELECT MAX(c.as_of) AS t FROM context_snapshots c JOIN sessions s ON s.id = c.session_id WHERE s.native_session_id = ?').get(sid) as { t: number | null };
    return row.t;
  } catch { return null; } finally { db?.close(); }
}

/** Every screen renders with a console free of errors (plan P4-T16, PRD §9.3). */
const consoleErrors: string[] = [];
test.beforeEach(() => { consoleErrors.length = 0; });
test.afterEach(() => { expect(consoleErrors, 'renderer console errors').toEqual([]); });

/** A fixed-offset zone where now is local midday, so "today" formatting (Resets HH:MM rather than a date, for a reset an
 *  hour ahead) never flips at a day boundary during a run (gate 4 clean-clone run near midnight UTC). Etc/GMT signs are
 *  inverted: Etc/GMT-5 is UTC+5. */
function middayZone(): string {
  const offset = 12 - new Date().getUTCHours(); // -11..+12
  return offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

/** live: seed and hook the two sessions; statusLine: also send SID's statusLine reading; kills: service kills the run expects. */
async function start(xaibo: Xaibo, { live = true, statusLine = true, kills = 0 } = {}) {
  if (live) xaibo.touchStore(() => seed(xaibo.home));
  const dataDir = path.join(path.dirname(xaibo.home), 'data-vis'); // short: the socket path
  const run = await xaibo.launch({ dataDir, env: { TZ: middayZone() }, serviceKills: kills });
  const page = await xaibo.window(run);
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await hideClockText(page);
  await expect(page.getByRole('status')).toContainText('Collection: Running', { timeout: 15_000 });
  if (!live) return { page, app: run.app! };
  // Both transcripts are imported before any hook: a statusLine reading that lands before the import would be followed by
  // the transcript's older reading, and Context would show either source from run to run.
  await expect.poll(() => lastContext(dataDir, SID), { timeout: 20_000 }).toBe(Date.parse(at(11)));
  await expect.poll(() => lastContext(dataDir, OTHER), { timeout: 20_000 }).toBe(Date.parse(at(2)));
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
  await hook(SID, CWD, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: `${CWD}/out.ts` }, tool_use_id: 'w1' });
  await hook(SID, CWD, 'PermissionRequest', { tool_name: 'Write' });
  if (!statusLine) return { page, app: run.app! };
  const reset = Math.floor(Date.now() / 1000);
  await hook(SID, null, 'statusline', { session_id: SID, model: { id: 'claude-opus-5-5', display_name: 'Synthetic Opus' }, cost: { total_cost_usd: 0.42 },
    context_window: { context_window_size: 200000, current_usage: { input_tokens: 1200, output_tokens: 50, cache_creation_input_tokens: 800, cache_read_input_tokens: 8000 } },
    rate_limits: { five_hour: { used_percentage: 42, resets_at: reset + 3600 }, seven_day: { used_percentage: 9, resets_at: reset + 5 * 86400 } } });
  return { page, app: run.app! };
}

const KILLS = 7; // usage-access.spec: 7 kills leave a 16-32 s restart backoff gap

/** Kills the service until the supervisor's backoff leaves a gap of several seconds; returns when it is down. */
async function disconnect(app: ElectronApplication, page: Page) {
  for (let i = 0; i < KILLS; i++) {
    process.kill(await servicePid(app), 'SIGKILL');
    if (i < KILLS - 1) await expect(page.getByRole('status')).toContainText('Collection: Running', { timeout: 30_000 });
  }
  await expect(page.getByRole('status')).toContainText('Collection: Restarting');
}

async function resize(app: ElectronApplication, page: Page, [w, h]: readonly [number, number]) {
  await app.evaluate(({ BrowserWindow }, [ww, hh]) => BrowserWindow.getAllWindows()[0]!.setSize(ww!, hh!), [w, h]);
  await expect.poll(() => page.evaluate(() => [window.outerWidth, window.outerHeight])).toEqual([w, h]);
  const inner = await page.evaluate(() => `${window.innerWidth}×${window.innerHeight}`);
  test.info().annotations.push({ type: 'content viewport', description: `${w}×${h} outer → ${inner} CSS px` });
}

/** What follows the real clock is hidden in every shot, since hook and statusLine times are stamped at delivery: each
 *  date, clock time and countdown substring becomes a grey bar (a CSS Custom Highlight: no DOM change, the rest of the
 *  label stays visible), and the quota-history chart is hidden (its x position is the time of day). Masks are not used:
 *  a mask is painted over the sticky frame when its element scrolls under it. The rules go in through CSSOM into the
 *  app's same-origin stylesheet, since the CSP blocks the <style> that toHaveScreenshot's `style` option would add.
 *  Ranges are rebuilt on every DOM change (rows re-render, countdowns tick). Elements holding such text get tabular
 *  digits, so the hidden span keeps one width whatever the time and the text after it does not move. */
const hideClockText = (page: Page) => page.evaluate(() => {
  const sheet = [...document.styleSheets].find((s) => s.href)!;
  sheet.insertRule('::highlight(vis-clock) { color: transparent; background-color: rgb(127 127 127 / 0.35); }', sheet.cssRules.length);
  sheet.insertRule('[data-vis-clock] { font-variant-numeric: tabular-nums !important; }', sheet.cssRules.length);
  sheet.insertRule('.x-history-chart { visibility: hidden !important; }', sheet.cssRules.length);
  // macOS overlay scrollbars show after a scroll and fade on their own timer
  sheet.insertRule('* { scrollbar-width: none !important; }', sheet.cssRules.length);
  // dates, clock times, and countdowns/elapsed times after "in " or "· " ("in 59 min 53 s", "· <1 s"); fixed durations
  // such as the cost table's "Cache write (5 min)" stay visible
  const CLOCK = /\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2})?|\d{1,2}:\d{2}|(?<=\bin |· )(?:< ?)?\d+ (?:d|h|min|s)\b(?: \d+ (?:d|h|min|s)\b)*/g;
  const mark = () => {
    const ranges: Range[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      for (const m of (t.nodeValue ?? '').matchAll(CLOCK)) {
        const r = new Range();
        r.setStart(t, m.index);
        r.setEnd(t, m.index + m[0].length);
        ranges.push(r);
        if (!t.parentElement?.hasAttribute('data-vis-clock')) t.parentElement?.setAttribute('data-vis-clock', '');
      }
    }
    CSS.highlights.set('vis-clock', new Highlight(...ranges));
  };
  mark();
  new MutationObserver(mark).observe(document.body, { subtree: true, childList: true, characterData: true });
});

async function shoot(page: Page, name: string, mask: Locator[] = []) {
  // Chromium draws focus-visible on a clicked button only sometimes; focus rings are covered by a11y-workspace.spec
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page).toHaveScreenshot(`${name}-${theme}.png`, { animations: 'disabled', caret: 'hide', scale: 'css', mask });
  }
}

// Dashboard view → [its button, text shown once its live data has loaded]
const VIEWS = { live: [/^Live sessions/, 'Live sessions'], attention: [/^Needs attention/, 'Confirmed requests'], usage: [/^Usage and history/, 'Observed quota history'] } as const;

/** The Dashboard top (summary) and each view scrolled to its heading; `ready` waits for the seeded live data. */
async function dashboardShots(page: Page, name: (view: string) => string, ready: boolean) {
  const views = page.getByRole('group', { name: 'Dashboard view' });
  await views.getByRole('button', { name: VIEWS.live[0] }).click();
  await page.locator('#dashboard-heading').evaluate((el) => { for (let p = el.parentElement; p; p = p.parentElement) p.scrollTop = 0; });
  await page.mouse.move(0, 0);
  await shoot(page, name('top'));
  for (const [view, [button, text]] of Object.entries(VIEWS)) {
    await views.getByRole('button', { name: button }).click();
    if (ready) await expect(page.locator(`#view-${view}`)).toContainText(text);
    await expect(page.locator('.x-dashboard').getByText(/Loading/)).toHaveCount(0, { timeout: 15_000 });
    await page.locator(`#view-${view}-heading`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.mouse.move(0, 0);
    await shoot(page, name(view));
  }
}

/** Opens the session whose list row shows exactly `cwd` (focus lands on its title). `status`: wait for the row's live
 *  status first, since a session opened before its status is known opens at its first turn, not its latest (design §6.3). */
async function openSession(page: Page, cwd: string, status?: RegExp) {
  await openSessions(page);
  const row = page.getByRole('list', { name: 'Sessions' }).getByRole('button').filter({ hasText: cwd }).filter({ hasNotText: `${cwd}-` }).first();
  if (status) await expect(row).toContainText(status, { timeout: 20_000 });
  await row.click({ timeout: 20_000 });
  await expect(page.locator('#open-session-title')).toBeFocused();
}

/** Selects a Session section and waits until it has stopped loading. */
async function showSection(page: Page, section: string) {
  const body = page.locator('#session-section-body');
  await page.getByRole('group', { name: 'Session section' }).getByRole('button', { name: new RegExp(`^${section}`) }).click();
  await expect(body).toHaveAttribute('aria-label', new RegExp(section, 'i'));
  await expect(body.getByText(/Loading/)).toHaveCount(0, { timeout: 15_000 });
  await page.mouse.move(0, 0);
  return body;
}

test('Dashboard: top, Live sessions, Needs attention and Usage at every baseline size, light and dark', async ({ xaibo }) => {
  test.setTimeout(240_000);
  const { page, app } = await start(xaibo);
  const live = page.getByRole('list', { name: 'Live sessions' });
  await expect(live.getByRole('listitem')).toHaveCount(2, { timeout: 20_000 });
  for (const size of SIZES) {
    await resize(app, page, size);
    await dashboardShots(page, (view) => `dashboard-${view}-${size.join('x')}`, true);
  }
});

for (const size of SIZES) {
  test(`Session ${size.join('×')}: every section and the Details drawer, light and dark`, async ({ xaibo }) => {
    test.setTimeout(240_000);
    const { page, app } = await start(xaibo);
    await resize(app, page, size);
    await openSession(page, CWD, /Waiting for permission/);
    for (const section of SECTIONS) {
      const body = await showSection(page, section);
      // the transcript's context reading shows (Stale) until the statusLine reading is ingested
      if (section === 'Context') await expect(body).toContainText('Source: Claude statusLine', { timeout: 15_000 });
      await shoot(page, `session-${section.toLowerCase()}-${size.join('x')}`);
    }
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close details' })).toBeVisible();
    await page.mouse.move(0, 0);
    await shoot(page, `session-details-${size.join('x')}`);
  });
}

// States (design §2.4, §6.13) at the default 960×640. Estimate is in the complete set above (Cost section and the
// Dashboard's ~$ known subtotal).
test('States 960×640, no hooks: empty views, unavailable usage, stale transcript context, empty sections', async ({ xaibo }) => {
  test.setTimeout(240_000);
  const { page, app } = await start(xaibo, { live: false }); // only the usage-basic fixture: one historical session, no live set
  await resize(app, page, [960, 640]);
  await dashboardShots(page, (view) => `state-nohooks-dashboard-${view}`, false);
  await openSession(page, '/tmp/xaibo-fixture/alpha');
  for (const section of SECTIONS) {
    await showSection(page, section);
    await shoot(page, `state-nohooks-session-${section.toLowerCase()}`);
  }
});

test('States 960×640, live without statusLine then collection lost: stale context, Restarting band, last known', async ({ xaibo }) => {
  test.setTimeout(240_000);
  const { page, app } = await start(xaibo, { statusLine: false, kills: KILLS });
  await resize(app, page, [960, 640]);
  await expect(page.getByRole('list', { name: 'Live sessions' }).getByRole('listitem')).toHaveCount(2, { timeout: 20_000 });
  await openSession(page, CWD);
  // stale: a live session whose only context reading is the transcript's (no statusLine)
  await expect(await showSection(page, 'Context')).toContainText('Source: Claude transcript');
  await shoot(page, 'state-stale-session-context');
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Dashboard', exact: true }).click();
  await disconnect(app, page); // the shots below fit in the restart backoff gap
  await page.locator('#dashboard-heading').evaluate((el) => { for (let p = el.parentElement; p; p = p.parentElement) p.scrollTop = 0; });
  await page.mouse.move(0, 0);
  await shoot(page, 'state-lost-dashboard-top');
  await openSessions(page);
  await page.mouse.move(0, 0);
  await shoot(page, 'state-lost-session');
  await expect(page.getByRole('status')).toContainText('Collection: Restarting'); // still inside the gap
});
