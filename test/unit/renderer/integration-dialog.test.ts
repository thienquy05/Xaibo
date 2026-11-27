// XAIBO-PROD-579 (P6-T10 unit 5; design §6.5.2, §5.1, §5.4, .handoff/p6-t10-design.md section 3 "Dialog phases", review
// R1/R8): the integration diff dialog model in agent-map/integration-dialog.ts. Every write is previewed first and applied by
// its preview id only after an explicit Apply; retention is default selected and deselectable (a replan, and Apply uses the
// replacement); tee is never asked for; needs-preview re-reviews and never resubmits; expiry, recalculation and an empty
// preview disable Apply; a lost apply result is Outcome unavailable; stale replies are dropped. Items, conflicts, effects
// and outcomes in words; which actions the panel offers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectPreview, IntegrationDetail, RemovalPreview } from '../../../src/shared/ipc.ts';
import { RESULT_UNAVAILABLE } from '../../../src/renderer/model.ts';
import { actionTitle, applyLabel, canApply, conflictTexts, dialogStep, effectTexts, nativeClose, openDialog, panelActions, previewItems, refusalText, teeHint, teeToggle, type DialogState } from '../../../src/renderer/agent-map/integration-dialog.ts';

const P = '00000000-0000-4000-8000-0000000c7901', Q = '00000000-0000-4000-8000-0000000c7902';
const V1 = '00000000-0000-4000-8000-0000000c79a1', V2 = '00000000-0000-4000-8000-0000000c79a2', V3 = '00000000-0000-4000-8000-0000000c79a3';
const E1 = '00000000-0000-4000-8000-0000000c79e1', E2 = '00000000-0000-4000-8000-0000000c79e2', E3 = '00000000-0000-4000-8000-0000000c79e3';
const hooks = { route: 'claude-plugin' as const, target: '/tmp/p/settings.json', diff: [{ pointer: '/enabledPlugins/xaibo@xaibo', new: true }],
  cli: { version: '2.1.332', argv: [['plugin', 'marketplace', 'add', '<plugin-dir>'], ['plugin', 'install', 'xaibo@xaibo']], writes: ['settings.json'] } };
const keep = { route: 'claude-retention' as const, target: '/tmp/p/settings.json', diff: [{ pointer: '/cleanupPeriodDays', new: 45, replaced: { type: 'number', sha256: 'abcdef012345' } }] };
const connectPreview = (id: string, retention: boolean): ConnectPreview => ({ status: 'preview', previewId: id, profileId: P, ttlMs: 300_000,
  steps: retention ? [hooks, keep] : [hooks], retention: { offered: true, from: 30, to: 45, layer: 'default' }, trustSteps: [] });
const detail = (o: Partial<{ agent: string; state: IntegrationDetail['row']['state']; entries: IntegrationDetail['entries']; profileId: string | null }> = {}): IntegrationDetail => ({
  row: { key: { agent: o.agent ?? 'claude', profileId: o.profileId === undefined ? P : o.profileId }, name: o.agent === 'codex' ? 'Codex' : 'Claude Code', profileLabel: 'Default profile', version: '2.1.332',
    state: o.state ?? 'detected', reasons: [], lifecycleGaps: [], receipt: null, content: { mode: 'unavailable', assurance: 'unavailable', evidence: null, gaps: [] } },
  profiles: [{ id: P, label: 'Default profile' }, { id: Q, label: '~/work-profile' }], entries: o.entries ?? [], trustSteps: [], boundary: null, compatibility: [], grants: null,
});
const reply = (s: DialogState, r: unknown) => dialogStep(s, { type: 'reply', seq: s.seq, reply: r as never });

test('Connect: opens loading with retention selected and tee never asked; the preview is reviewed, then applied by its id', () => {
  const o = openDialog({ kind: 'connect', profileId: P });
  assert.equal(o.s.phase, 'loading');
  assert.deepEqual(o.send, { seq: o.s.seq, kind: 'preview', retention: true });
  assert.equal(canApply(o.s), false);
  const r = reply(o.s, connectPreview(V1, true));
  assert.equal(r.s.phase, 'review');
  assert.equal(r.send, undefined, 'a preview never applies by itself');
  assert.equal(canApply(r.s), true);
  const a = dialogStep(r.s, { type: 'apply' });
  assert.equal(a.s.phase, 'applying');
  assert.deepEqual(a.send, { seq: a.s.seq, kind: 'apply', previewId: V1 });
  assert.equal(canApply(a.s), false);
  assert.equal(dialogStep(a.s, { type: 'apply' }).send, undefined, 'no double apply');
  const done = reply(a.s, { status: 'applied', entries: [E1], trustSteps: [] });
  assert.equal(done.s.phase, 'success');
  assert.equal(done.s.text, 'Changes applied.');
});

test('retention: deselecting replans, Apply waits for the replacement and then uses only its id; the row stays, unchecked', () => {
  const r = reply(openDialog({ kind: 'connect', profileId: P }).s, connectPreview(V1, true));
  const items = previewItems(r.s, detail());
  assert.deepEqual(items.map((i) => [i.id, i.check]), [['hooks', 'required'], ['retention', 'on']]);
  assert.ok(items[1]!.title.includes('30') && items[1]!.title.includes('45'), items[1]!.title);
  assert.ok(items[1]!.lines.some((l) => l.kind === 'add' && l.text.includes('/cleanupPeriodDays')));
  assert.ok(items[1]!.lines.some((l) => l.kind === 'remove' && l.text.includes('number') && l.text.includes('abcdef012345')), 'a replaced value: its type and hash only');
  const off = dialogStep(r.s, { type: 'retention', on: false });
  assert.equal(off.s.phase, 'recalculating');
  assert.deepEqual(off.send, { seq: off.s.seq, kind: 'preview', retention: false });
  assert.equal(canApply(off.s), false, 'no Apply while replanning');
  assert.equal(dialogStep(off.s, { type: 'apply' }).send, undefined);
  assert.equal(reply(r.s, connectPreview(V3, true)).s, r.s, 'a reply with no request outstanding is dropped');
  const stale = dialogStep(off.s, { type: 'reply', seq: r.s.seq, reply: connectPreview(V3, true) });
  assert.equal(stale.s, off.s, 'the superseded reply is dropped');
  const replanned = reply(off.s, connectPreview(V2, false));
  assert.equal(replanned.s.phase, 'review');
  const again = previewItems(replanned.s, detail());
  assert.deepEqual(again.map((i) => [i.id, i.check]), [['hooks', 'required'], ['retention', 'off']]);
  assert.equal(again[1]!.lines.filter((l) => l.kind !== 'note').length, 0, 'a deselected retention changes nothing');
  assert.deepEqual(dialogStep(replanned.s, { type: 'apply' }).send, { seq: replanned.s.seq + 1, kind: 'apply', previewId: V2 });
});

test('the plugin step names what runs and what it writes; a retention not offered says why and has no checkbox', () => {
  const r = reply(openDialog({ kind: 'connect', profileId: P }).s, { ...connectPreview(V1, false), retention: { offered: false, reason: 'policy', days: null } });
  const [h, t] = previewItems(r.s, detail());
  assert.ok(h!.lines.some((l) => l.kind === 'note' && l.text.includes('plugin install xaibo@xaibo')), JSON.stringify(h!.lines));
  assert.ok(h!.lines.some((l) => l.kind === 'note' && l.text.includes('/tmp/p/settings.json')));
  assert.equal(t!.check, null);
  assert.match(t!.title, /not offered/);
  const codex = reply(openDialog({ kind: 'connect', profileId: P }).s, { status: 'preview', previewId: V1, profileId: P, ttlMs: 1, retention: null, trustSteps: ['Open Codex once and trust the hooks.'],
    steps: [{ route: 'codex-hooks', target: '/tmp/c/hooks.json', diff: [{ pointer: '/hooks/Stop/1', new: { hooks: [] } }] }] });
  assert.deepEqual(previewItems(codex.s, detail({ agent: 'codex' })).map((i) => i.id), ['hooks'], 'no retention row without an offer');
  const fx = effectTexts(codex.s);
  assert.ok(fx.some((f) => f.includes('Open Codex once')), 'trust steps are named before Apply');
  assert.ok(fx.some((f) => /other tools stay/.test(f)), 'foreign commands are preserved');
});

test('needs-preview re-reviews the fresh preview with a note and never resubmits; a refused one fails with Close', () => {
  const a = dialogStep(reply(openDialog({ kind: 'connect', profileId: P }).s, connectPreview(V1, true)).s, { type: 'apply' });
  const n = reply(a.s, { status: 'needs-preview', preview: connectPreview(V2, true) });
  assert.equal(n.s.phase, 'review');
  assert.equal(n.send, undefined);
  assert.equal(n.s.preview?.previewId, V2);
  assert.match(n.s.text, /changed/);
  const f = reply(a.s, { status: 'needs-preview', preview: { status: 'refused', code: 'invalid-json' } });
  assert.equal(f.s.phase, 'failed');
  assert.equal(canApply(f.s), false);
  const c = dialogStep(dialogStep(reply(openDialog({ kind: 'cleanup', profileId: P }).s, { status: 'preview', previewId: V1, ttlMs: 1, items: [{ entry: E1, cleanup: ['manifest-entry'] }] }).s, { type: 'apply' }).s,
    { type: 'reply', seq: 2, reply: { status: 'needs-preview' } });
  assert.equal(c.s.phase, 'failed');
  assert.match(c.s.text, /changed/);
});

test('expiry, refusals, partial and a lost result', () => {
  const r = reply(openDialog({ kind: 'connect', profileId: P }).s, connectPreview(V1, true));
  assert.equal(dialogStep(r.s, { type: 'expired', previewId: V2 }).s, r.s, 'another preview\'s timer changes nothing');
  const x = dialogStep(r.s, { type: 'expired', previewId: V1 });
  assert.equal(x.s.expired, true);
  assert.equal(canApply(x.s), false);
  assert.equal(dialogStep(x.s, { type: 'apply' }).send, undefined);
  assert.match(x.s.text, /expired/);
  const refusedPreview = reply(openDialog({ kind: 'connect', profileId: P }).s, { status: 'refused', code: 'real-profile' });
  assert.equal(refusedPreview.s.phase, 'failed');
  assert.equal(refusedPreview.s.text, refusalText('real-profile'));
  assert.equal(refusalText('some-new-code'), "Couldn't continue (some-new-code).");
  const a = dialogStep(r.s, { type: 'apply' });
  assert.equal(reply(a.s, { status: 'refused', code: 'busy' }).s.phase, 'failed');
  const p = reply(a.s, { status: 'partial', reverted: [], conflicts: [], remaining: [{ entry: E1, route: 'claude-plugin', reason: 'plugin' }], code: 'plugin' });
  assert.equal(p.s.phase, 'failed');
  assert.match(p.s.text, /not completed/);
  const lost = dialogStep(a.s, { type: 'lost', seq: a.s.seq });
  assert.equal(lost.s.phase, 'unavailable');
  assert.equal(lost.s.text, RESULT_UNAVAILABLE);
  assert.equal(dialogStep(lost.s, { type: 'apply' }).send, undefined, 'no resubmission');
  assert.equal(dialogStep(openDialog({ kind: 'uninstall' }).s, { type: 'lost', seq: 1 }).s.phase, 'failed', 'a lost preview is a failure, nothing was written');
  const gone = dialogStep(r.s, { type: 'lost', seq: r.s.seq }); // re-review M: the service went away while reviewing
  assert.equal(gone.s.phase, 'review');
  assert.equal(canApply(gone.s), false, 'no Apply into a dead connection; Cancel still closes');
  assert.match(gone.s.text, /connection/);
  const empty = reply(openDialog({ kind: 'disconnect', profileId: P }).s, { status: 'preview', previewId: V1, profileId: P, ttlMs: 1, items: [] });
  assert.equal(canApply(empty.s), false, 'nothing to apply');
});

test('removal: Disconnect and Full Uninstall name each entry, its profile and what happens; conflicts listed; history kept', () => {
  const items: RemovalPreview['items'] = [
    { entry: E1, route: 'claude-plugin', profileId: P, state: 'connected', reason: null },
    { entry: E2, route: 'codex-hooks', profileId: null, state: 'drifted', reason: null },
    { entry: E3, route: 'claude-tee', profileId: Q, state: 'unreadable', reason: 'refused' },
  ];
  const u = reply(openDialog({ kind: 'uninstall' }).s, { status: 'preview', previewId: V1, profileId: null, ttlMs: 1, items });
  assert.equal(actionTitle(u.s.action, 'Claude Code'), 'Full Uninstall: all profiles');
  assert.equal(applyLabel(u.s.action), 'Uninstall from all profiles');
  const shown = previewItems(u.s, detail());
  assert.deepEqual(shown.map((i) => [i.id, i.check]), [[E1, null], [E2, null], [E3, null]], 'removal items are not selectable');
  assert.equal(shown[0]!.title, 'Claude plugin hooks · Default profile');
  assert.equal(shown[1]!.title, 'Codex hooks · another profile');
  assert.equal(shown[2]!.title, 'Status-line tee · ~/work-profile');
  const conflicts = conflictTexts(u.s, detail());
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts[0]!.includes('Codex hooks') && /changed outside Xaibo/.test(conflicts[0]!));
  assert.ok(conflicts[1]!.includes('refused'));
  assert.ok(effectTexts(u.s).some((f) => /history is kept/.test(f)));
  const done = reply(dialogStep(u.s, { type: 'apply' }).s, { status: 'disconnected', reverted: [{ entry: E1, route: 'claude-plugin', result: 'removed' }], conflicts: [{ entry: E2, route: 'codex-hooks', pointer: '/hooks/Stop/0' }], remaining: [] });
  assert.equal(done.s.phase, 'success');
  assert.match(done.s.text, /1 changed value kept/);
  // revertAll marks kept conflicts partial: with nothing remaining and no code every entry was reverted (conflicts preserved)
  const kept = reply(dialogStep(u.s, { type: 'apply' }).s, { status: 'partial', reverted: [{ entry: E1, route: 'claude-plugin', result: 'removed' }, { entry: E2, route: 'codex-hooks', result: 'structural' }], conflicts: [{ entry: E2, route: 'codex-hooks', pointer: '/hooks/Stop/0' }], remaining: [] });
  assert.equal(kept.s.phase, 'success');
  assert.equal(kept.s.text, 'Uninstalled from all profiles: 2 entries removed or restored; 1 changed value kept.');
  const d = openDialog({ kind: 'disconnect', profileId: P });
  assert.deepEqual(d.send, { seq: d.s.seq, kind: 'preview', retention: false });
  assert.equal(actionTitle(d.s.action, 'Codex'), 'Disconnect Codex');
  assert.equal(dialogStep(reply(d.s, { status: 'preview', previewId: V1, profileId: P, ttlMs: 1, items }).s, { type: 'retention', on: true }).send, undefined, 'only Connect has a retention row');
});

test('code review H1: a dialog opens with a seq above every earlier one, so a late reply from a cancelled open is dropped', () => {
  const first = openDialog({ kind: 'uninstall' });
  const next = openDialog({ kind: 'disconnect', profileId: P }, first.s.seq + 1);
  assert.deepEqual(next.send, { seq: first.s.seq + 1, kind: 'preview', retention: false });
  const late = dialogStep(next.s, { type: 'reply', seq: first.s.seq, reply: { status: 'preview', previewId: V1, profileId: null, ttlMs: 1, items: [] } });
  assert.equal(late.s, next.s, 'the cancelled Full Uninstall preview never lands in the Disconnect dialog');
});

test('code review L3: removed or restored counts only entries that changed; unchanged ones are kept values', () => {
  const u = reply(openDialog({ kind: 'disconnect', profileId: P }).s, { status: 'preview', previewId: V1, profileId: P, ttlMs: 1, items: [{ entry: E1, route: 'codex-hooks', profileId: P, state: 'drifted', reason: null }] });
  const r = reply(dialogStep(u.s, { type: 'apply' }).s, { status: 'partial', reverted: [{ entry: E1, route: 'codex-hooks', result: 'unchanged' }], conflicts: [{ entry: E1, route: 'codex-hooks', pointer: '/hooks/Stop/0' }], remaining: [] });
  assert.equal(r.s.text, 'Disconnected: 0 entries removed or restored; 1 changed value kept.');
});

test('cleanup lists each leftover in words and reports what was removed', () => {
  const c = reply(openDialog({ kind: 'cleanup', profileId: P }).s, { status: 'preview', previewId: V1, ttlMs: 1, items: [{ entry: E1, cleanup: ['manifest-entry', 'backup'] }] });
  const [i] = previewItems(c.s, detail({ entries: [{ entry: E1, route: 'codex-hooks', state: 'disconnected-externally', reason: null }] }));
  assert.equal(i!.title, 'Codex hooks · Default profile');
  assert.ok(i!.lines.every((l) => l.kind === 'remove') && i!.lines.length === 2, JSON.stringify(i!.lines));
  const done = reply(dialogStep(c.s, { type: 'apply' }).s, { status: 'cleaned', removed: [E1], left: [] });
  assert.equal(done.s.phase, 'success');
  assert.match(done.s.text, /^Cleaned up/);
});

test('XAIBO-PROD-581 (unit 6b): the separate tee: its own preview, one item, its own words; never a retention row', () => {
  const on = openDialog({ kind: 'tee', profileId: P, enabled: true });
  assert.deepEqual(on.send, { seq: on.s.seq, kind: 'preview', retention: false });
  assert.equal(actionTitle(on.s.action, 'Claude Code'), 'Turn on the status-line tee: Claude Code');
  assert.equal(applyLabel(on.s.action), 'Turn on tee');
  const r = reply(on.s, { status: 'preview', previewId: V1, profileId: P, ttlMs: 1, retention: null, trustSteps: [],
    steps: [{ route: 'claude-tee', target: '/tmp/p/settings.json', diff: [{ pointer: '/statusLine/command', new: "'/x/xaibo-statusline' tee", replaced: { type: 'string', sha256: 'abcdef012345' } }] }] });
  const items = previewItems(r.s, detail());
  assert.deepEqual(items.map((i) => [i.id, i.title, i.check]), [['tee', 'Status-line tee', null]], 'nothing to select: the toggle was the choice');
  assert.ok(items[0]!.lines.some((l) => l.kind === 'add' && l.text.includes('/statusLine/command')));
  assert.equal(dialogStep(r.s, { type: 'retention', on: true }).send, undefined);
  assert.ok(effectTexts(r.s).some((f) => /^Adds Xaibo's status-line tee; any existing status line keeps showing/.test(f)), 'review 6b nit: no status line yet is fine too');
  assert.ok(effectTexts(r.s).some((f) => /Hooks are not changed/.test(f)));
  assert.equal(reply(dialogStep(r.s, { type: 'apply' }).s, { status: 'applied', entries: [E1], trustSteps: [] }).s.text, 'Status-line tee on.');
  const off = openDialog({ kind: 'tee', profileId: P, enabled: false });
  assert.equal(actionTitle(off.s.action, 'Claude Code'), 'Turn off the status-line tee: Claude Code');
  assert.equal(applyLabel(off.s.action), 'Turn off tee');
  const o = reply(off.s, { status: 'preview', previewId: V2, profileId: P, ttlMs: 1, items: [{ entry: E1, route: 'claude-tee', profileId: P, state: 'connected', reason: null }] });
  assert.deepEqual(previewItems(o.s, detail()).map((i) => i.title), ['Status-line tee · Default profile']);
  assert.ok(effectTexts(o.s).some((f) => /status line as it was/.test(f)));
  assert.equal(reply(dialogStep(o.s, { type: 'apply' }).s, { status: 'disconnected', reverted: [{ entry: E1, route: 'claude-tee', result: 'restored' }], conflicts: [], remaining: [] }).s.text, 'Status-line tee off.');
  assert.equal(refusalText('statusline'), "The status line isn't a command Xaibo can wrap. Nothing was changed.");
  assert.equal(refusalText('duplicate'), 'Xaibo is already set up in this configuration.', 'review 6b L4: true for hooks and for an unrecorded tee');
});

test('XAIBO-PROD-581: the tee toggle is offered for a detected Claude profile only; it mirrors the recorded tee', () => {
  const tee = (state: IntegrationDetail['entries'][number]['state']) => [{ entry: E1, route: 'claude-tee' as const, state, reason: null }];
  assert.equal(teeToggle(detail()), 'off');
  assert.equal(teeToggle(detail({ entries: tee('connected') })), 'on');
  assert.equal(teeToggle(detail({ entries: tee('drifted') })), 'on', 'changed outside Xaibo: still Xaibo\'s to turn off');
  assert.equal(teeToggle(detail({ agent: 'codex' })), null);
  assert.equal(teeToggle(detail({ profileId: null })), null);
  assert.equal(teeToggle(detail({ state: 'not-detected' })), null);
  assert.equal(teeToggle(detail({ state: 'unsupported-version' })), null);
  // review 6b L2/L3: the toggle warns that a preview comes first (WCAG 3.2.2) and names only an unusual state
  const warn = 'Changing it shows a preview first; nothing changes until you apply.';
  assert.equal(teeHint(detail()), warn);
  assert.equal(teeHint(detail({ entries: tee('connected') })), warn);
  assert.equal(teeHint(detail({ entries: tee('drifted') })), `${warn} Status-line tee: changed outside Xaibo.`);
});

test('unit 6b E2E finding: a native close event is queued; one arriving after the dialog reopened is stale and ignored', () => {
  const s = openDialog({ kind: 'tee', profileId: P, enabled: true }).s;
  assert.equal(nativeClose(s, true), 'ignore', 'Escape closed the old dialog, Space reopened it, then the old close event arrived');
  assert.equal(nativeClose(null, false), 'ignore', 'our own close already cleared the state');
  assert.equal(nativeClose({ ...s, phase: 'applying' }, false), 'reopen', 'applying blocks dismissal');
  assert.equal(nativeClose(s, false), 'closed', 'a close we did not ask for before applying');
});

test('the panel offers each write only where it applies (and none for a profile-less or undetected agent)', () => {
  const e = (route: IntegrationDetail['entries'][number]['route'], state: IntegrationDetail['entries'][number]['state'] = 'connected') => ({ entry: E1, route, state, reason: null });
  assert.deepEqual(panelActions(detail()), ['connect']);
  assert.deepEqual(panelActions(detail({ state: 'unsupported-version' })), []);
  assert.deepEqual(panelActions(detail({ state: 'not-detected' })), []);
  assert.deepEqual(panelActions(detail({ profileId: null })), []);
  assert.deepEqual(panelActions(detail({ agent: 'gemini' })), [], 'Gemini runtime capabilities stay off');
  assert.deepEqual(panelActions(detail({ agent: 'codex', state: 'awaiting-trust', entries: [e('codex-hooks')] })), ['disconnect', 'uninstall']);
  assert.deepEqual(panelActions(detail({ entries: [e('claude-retention')] })), ['connect', 'disconnect', 'uninstall'], 'retention alone is no lifecycle hook');
  assert.deepEqual(panelActions(detail({ agent: 'codex', state: 'setup-required', entries: [e('codex-hooks', 'disconnected-externally')] })), ['disconnect', 'uninstall', 'cleanup']);
});
