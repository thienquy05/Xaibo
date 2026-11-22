// P4-T14 (EC-97 E; FR-49, §6.9, design §6.1, §6.3, §6.13, §7): usage status, live-set totals, the context view and
// session access (Conversation, Timeline, Files, Context, Cost) in the narrow (720×640) and wide (1280×800) layouts
// (design §2.3/§2.4), each with complete, missing, stale and collector-disconnected data. Every surface is reached by
// keyboard only; accessible text carries exact values and coverage; missing data reads unavailable, never zero; stale
// readings say Stale; a disconnected collector leaves no unqualified live label. Synthetic ids and paths only.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { claudeProfile, deliver } from '../helpers/hook-socket.ts';
import { expect, servicePid, shot, tabTo, test, type Run, type Xaibo } from './fixtures.ts';

const SID = '00000000-0000-4000-8000-0000000fa001';
const CWD = '/tmp/xaibo-fixture/usage-access';
const CODEX_SID = '00000000-0000-4000-8000-0000000fa0c1';
const LAYOUTS = { narrow: [720, 640], wide: [1280, 800] } as const;
const STATES = ['complete', 'missing', 'stale', 'disconnected'] as const;
type State = (typeof STATES)[number];
const MIN = 60_000;

/** A live Claude session's transcript: a prompt and a reply, the reply with usage unless `usage` is false. */
function claudeTranscript(home: string, at: number, usage: boolean) {
  const project = path.join(home, '.claude', 'projects', CWD.replaceAll('/', '-'));
  mkdirSync(project, { recursive: true });
  const base = (type: string, i: number) => ({ parentUuid: null, isSidechain: false, type, uuid: `00000000-0000-4000-8000-0000000fa1${String(i).padStart(2, '0')}`,
    timestamp: new Date(at + i * 1000).toISOString(), userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId: SID, version: '2.1.319' });
  writeFileSync(path.join(project, `${SID}.jsonl`), [
    { ...base('user', 1), message: { role: 'user', content: 'Summarize the notes' } },
    { ...base('assistant', 2), message: { model: 'claude-opus-5-5', id: 'msg_usage_access', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }],
      // the price table needs the standard tier/speed qualifiers and the cache-write duration split, as real usage carries
      ...(usage ? { usage: { input_tokens: 1200, cache_read_input_tokens: 8000, cache_creation_input_tokens: 800, output_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 800, ephemeral_1h_input_tokens: 0 }, service_tier: 'standard', speed: 'standard' } } : {}) } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
}

/** A Codex rollout with one token_count reading measured at `at` (rate limits that reset in the future). */
function codexRollout(home: string, at: number) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '16');
  mkdirSync(dir, { recursive: true });
  const ts = (s: number) => new Date(at + s * 1000).toISOString();
  const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
  writeFileSync(path.join(dir, `rollout-2026-11-16T00-00-00-${CODEX_SID}.jsonl`), [
    { timestamp: ts(0), type: 'session_meta', payload: { id: CODEX_SID, timestamp: ts(0), cwd: '/tmp/xaibo-fixture/usage-codex', originator: 'codex-tui', cli_version: '0.160.0', source: 'cli' } },
    { timestamp: ts(1), type: 'turn_context', payload: { turn_id: 't1', cwd: '/tmp/xaibo-fixture/usage-codex', model: 'gpt-6.1-sol' } },
    { timestamp: ts(2), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0, total_tokens: 1200 },
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0, total_tokens: 1200 }, model_context_window: 200000 },
    rate_limits: { limit_name: null, primary: { used_percent: 37, window_minutes: 300, resets_at: reset }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: reset + 86400 } } } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
}



async function start(xaibo: Xaibo, state: State, layout: keyof typeof LAYOUTS) {
  xaibo.touchStore(() => {
    claudeTranscript(xaibo.home, state === 'stale' ? Date.now() - 20 * MIN : Date.now() - 10_000, state !== 'missing');
    if (state !== 'missing') codexRollout(xaibo.home, state === 'stale' ? Date.now() - 20 * MIN : Date.now() - 10_000);
  });
  const dataDir = path.join(path.dirname(xaibo.home), 'data-ua'); // short: the socket path
  const run = await xaibo.launch({ dataDir, ...(state === 'disconnected' ? { serviceKills: 7 } : {}) });
  const page = await xaibo.window(run);
  const [w, h] = LAYOUTS[layout];
  await run.app!.evaluate(({ BrowserWindow }, [ww, hh]) => BrowserWindow.getAllWindows()[0]!.setSize(ww!, hh!), [w, h]);
  await expect(page.getByRole('status')).toContainText('Collection: Running', { timeout: 15_000 });
  let profile: string | null = null;
  await expect.poll(() => (profile = claudeProfile(dataDir)), { timeout: 15_000 }).toBeTruthy();
  await expect.poll(() => existsSync(path.join(dataDir, 'run', 'token')), { timeout: 15_000 }).toBe(true);
  const send = async (event: string, payload: Record<string, unknown>, cwd: string | null = CWD) => {
    const ack = await deliver(dataDir, { v: 1, delivery_id: randomUUID(), agent: 'claude', profile_key: profile!, event, session_id: SID, cwd, received_ts: Date.now(), payload });
    expect(ack).toMatchObject({ status: 'accepted' });
  };
  await send('SessionStart', { hook_event_name: 'SessionStart', session_id: SID, source: 'startup' });
  await send('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'fixture prompt' });
  if (state === 'complete' || state === 'disconnected') {
    await send('statusline', { session_id: SID, model: { id: 'claude-opus-5-5', display_name: 'Synthetic Opus' }, cost: { total_cost_usd: 0.42 },
      context_window: { context_window_size: 200000, current_usage: { input_tokens: 1200, output_tokens: 50, cache_creation_input_tokens: 800, cache_read_input_tokens: 8000 } },
      rate_limits: { five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { used_percentage: 9, resets_at: Math.floor(Date.now() / 1000) + 5 * 86400 } } }, null);
  }
  return { run, page, send };
}

/** Kills the service until the supervisor's backoff leaves a gap of several seconds; returns when it is down. */
async function disconnect(run: Run, page: Page) {
  // review M: 7 kills leave a 16-32 s backoff gap, room for every gap check on a slow machine
  for (let i = 0; i < 7; i++) {
    const pid = await servicePid(run.app!);
    process.kill(pid, 'SIGKILL');
    if (i < 6) await expect(page.getByRole('status')).toContainText('Collection: Running', { timeout: 30_000 });
  }
  await expect(page.getByRole('status')).toContainText('Collection: Restarting');
}

for (const layout of Object.keys(LAYOUTS) as (keyof typeof LAYOUTS)[]) {
  for (const state of STATES) {
    test(`${layout} × ${state}: usage, live-set totals, context and session access by keyboard`, async ({ xaibo }) => {
      test.setTimeout(120_000);
      const { run, page } = await start(xaibo, state, layout);
      const areas = page.getByRole('navigation', { name: 'Areas' });
      const totals = page.getByRole('region', { name: /live-session set/i });
      // the Claude session (hooks) and, except when missing, the Codex rollout (file-only, recent) are live
      await expect(totals).toContainText(`${state === 'missing' ? 1 : 2} currently tracked`, { timeout: 20_000 });

      // Dashboard by keyboard: the Areas link, then Usage and history through the view group's arrow keys
      await page.locator('body').focus();
      await tabTo(page, areas.getByRole('link', { name: 'Dashboard' }));
      await page.keyboard.press('Enter');
      const views = page.getByRole('group', { name: 'Dashboard view' });
      await expect(page.locator('#dashboard-heading')).toBeFocused(); // the Areas link moved focus here
      await tabTo(page, views.getByRole('button', { pressed: true }));
      await page.keyboard.press('End');
      await expect(views.getByRole('button', { name: 'Usage and history' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(views.getByRole('button', { name: 'Usage and history' })).toHaveAttribute('aria-pressed', 'true');
      const claude = page.getByRole('region', { name: /^Claude Code · / }).first();
      const codex = page.getByRole('region', { name: /^Codex · / }).first();
      await expect(claude).toBeVisible({ timeout: 15_000 }); // scopes load after the view is selected
      if (state !== 'missing') await expect(codex.locator('[data-field="usage-value"]').first()).toHaveText(/^37%/, { timeout: 15_000 });
      // collector loss after the scopes were loaded: they must stay readable and stop reading as current
      if (state === 'disconnected') await disconnect(run, page);

      // without a statusLine reading the Claude scope has no window to page: it is read, not tabbed to
      if (state === 'missing' || state === 'stale') await expect(claude).toContainText('Unavailable — no statusLine quota observation');
      else {
        await tabTo(page, claude.getByRole('button', { name: 'Observed history' }).first()); // one per window
        await expect(claude.locator('[data-field="usage-value"]').first()).toHaveText(/^42%/);
      }
      if (state !== 'missing') {
        await tabTo(page, codex.getByRole('button', { name: 'Observed history' }).first());
        if (state === 'stale') await expect(codex).toContainText('Stale ·');
        else await expect(codex).not.toContainText('Stale ·');
      }
      if (state === 'disconnected') { // design §6.13 B4: a last-loaded reading is never presented as current
        await expect(claude).toContainText('Last known · since');
        await expect(codex).toContainText('Last known · since');
        await shot(page, `${layout}-usage-collector-lost`);
      }

      // live-set totals: read in the Dashboard summary (static facts are not tab stops)
      const tokens = totals.locator('dd[data-field="tokens"]');
      if (state === 'missing') {
        await expect(tokens).toContainText('Unavailable');
        await expect(tokens).not.toContainText(/\b0 tokens/);
      } else {
        // Claude 1,200 + 8,000 + 800 input + 50 output = 10,050; Codex 1,000 + 200 = 1,200
        await expect(tokens).toContainText('11,250 tokens observed for 2 of 2 sessions');
        // complete: the Claude statusLine reports $0.42; stale: calculated from its tokens; the Codex request has no tier: unpriced
        await expect(totals.locator('dd[data-field="cost"]')).toContainText(state === 'stale' ? /~\$0\.01\S* known subtotal priced for 1 of 2 sessions · coverage below 80%/
          : '~$0.42 known subtotal priced for 1 of 2 sessions · coverage below 80%');
      }
      if (state === 'disconnected') await expect(totals.getByRole('heading')).toContainText('Last known live-session set');
      else await expect(totals.getByRole('heading')).toHaveText('Live-session set');

      // Session area by keyboard: Areas link → the session row → its sections
      await tabTo(page, areas.getByRole('link', { name: 'Session' }));
      await page.keyboard.press('Enter');
      await expect(page.locator('#sessions-heading')).toBeFocused(); // the Areas link moves focus here a frame later
      const row = page.getByRole('list', { name: 'Sessions' }).getByRole('button').filter({ hasText: CWD }).first();
      await tabTo(page, row);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => { const e = document.activeElement; return e?.id === 'open-session-title' ? 'title' : `${e?.tagName}#${e?.id}.${e?.className}`; }),
        { message: 'opening a session moves focus to its title' }).toBe('title');
      if (layout === 'narrow') await expect(page.getByRole('button', { name: 'Back to session list' })).toBeVisible();
      const section = (name: string) => page.getByRole('group', { name: 'Session section' }).getByRole('button', { name: new RegExp(`^${name}`) });
      // XAIBO-PROD-437 (design §8.1): the section group is one tab stop; Home and Right reach the others
      const open = async (name: string) => {
        await tabTo(page, page.getByRole('group', { name: 'Session section' }).getByRole('button', { pressed: true }));
        await page.keyboard.press('Home');
        for (let i = 0; i < 7 && !(await section(name).evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Enter');
        return page.getByRole('region', { name, exact: true });
      };

      // During collector loss a section either shows what it has or says it is loading (never blank, never zero); once the
      // collector runs again the content arrives without a restart (EC-97: content access preserved).
      const sections = async (gap: boolean) => {
        const loading = (expected: RegExp) => new RegExp(`${expected.source}|Loading`);
        const conversation = await open('Conversation');
        if (gap) await expect(conversation).toContainText(loading(/Summarize the notes/));
        else {
          // The session was opened during the gap, so its first transcript request went to the dead port: it fails when the
          // restarted service brings a new port (XAIBO-PROD-434), and the reconnect then reloads it by itself, with no Retry
          // press (XAIBO-PROD-436, owner decision D-P4-09). A stuck "Loading" or a waiting Retry fails this check.
          await expect(conversation.getByRole('list', { name: 'Conversation' })).toContainText('Summarize the notes', { timeout: 20_000 });
          await expect(page.getByRole('alert').getByRole('button', { name: 'Retry' })).toHaveCount(0);
        }
        const timeline = await open('Timeline');
        if (gap) await expect(timeline).toContainText(loading(/Activity|Summarize/));
        else await expect(timeline.getByRole('list', { name: 'Activity sequence' })).toBeVisible({ timeout: 20_000 });
        const files = await open('Files');
        if (gap) await shot(page, `${layout}-files-collector-lost`);
        await expect(files).toContainText(gap ? loading(/No file touches recorded|Files touched/) : /No file touches recorded|Files touched/, { timeout: gap ? 5000 : 20_000 });
        const context = await open('Context');
        if (gap) await expect(context).toContainText(loading(/Context: 5 percent; 10,000 of 200,000 tokens/));
        else {
          await expect(context.getByRole('heading', { name: 'Current context' })).toBeVisible({ timeout: 20_000 });
          if (state === 'missing') {
            await expect(context).toContainText(/unavailable/i);
            await expect(context).not.toContainText(/\b0 tokens/);
          } else if (state === 'stale') await expect(context).toContainText('Stale');
          else await expect(context).toContainText('Context: 5 percent; 10,000 of 200,000 tokens; source Claude statusLine'); // exact headline text
        }
        const cost = await open('Cost');
        if (gap) await expect(cost).toContainText(loading(/Estimated cost: .+; agent-reported estimate/));
        else {
          await expect(cost.getByRole('heading', { name: 'Estimated cost' })).toBeVisible({ timeout: 20_000 });
          if (state === 'missing') await expect(cost).toContainText('Estimated cost unavailable');
          // with the statusLine the agent's own estimate leads (basis stated); without it the cost is calculated from tokens
          else if (state === 'stale') await expect(cost.getByText(/^Estimated cost: .+; 1 of 1 requests priced/)).toHaveCount(1);
          else await expect(cost.getByText(/^Estimated cost: .+; agent-reported estimate/)).toHaveCount(1);
        }
      };
      if (state === 'disconnected') {
        await expect(page.getByRole('status')).toContainText('Collection: Restarting'); // still in the gap before its checks
        await sections(true);
        await expect(page.getByRole('status')).not.toContainText('Collection: Running'); // the checks above ran during the gap
        await expect(page.locator('main')).not.toContainText(/(^|[^n] )Live sessions/); // only "Last known live sessions"
        await expect(page.getByRole('status')).toContainText('Collection: Running', { timeout: 40_000 });
      }
      await sections(false);
    });
  }
}

// XAIBO-PROD-449 (G4c-2): a usage reading stored within 5 s of the view's first read, with no later activity, is fetched
// when the throttle window ends; before, the throttled tick scheduled nothing and the reading waited for new activity.
test('a usage reading stored right after the first read appears without later activity', async ({ xaibo }) => {
  test.setTimeout(90_000);
  const { page, send } = await start(xaibo, 'missing', 'wide'); // no statusLine reading yet
  await expect(page.getByRole('region', { name: /live-session set/i })).toContainText('1 currently tracked', { timeout: 20_000 });
  await page.getByRole('group', { name: 'Dashboard view' }).getByRole('button', { name: 'Usage and history' }).click();
  const claude = page.getByRole('region', { name: /^Claude Code · / }).first();
  await expect(claude).toContainText('Unavailable — no statusLine quota observation', { timeout: 15_000 }); // the first read
  const sent = Date.now();
  await send('statusline', { session_id: SID, model: { id: 'claude-opus-5-5', display_name: 'Synthetic Opus' },
    rate_limits: { five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 } } }, null);
  await expect(claude.locator('[data-field="usage-value"]').first()).toHaveText(/^42%/, { timeout: 6500 });
  expect(Date.now() - sent).toBeLessThan(6500);
});
