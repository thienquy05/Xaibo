// XAIBO-PROD-535 (P5-T18 part 3b-6; design §5.4 Move to project/folder, §5.1 dialog transactions): pure logic in
// history/move.ts: the draft from the fresh row, name validation, the op sequence (newProject, newFolder, move), every
// outcome in words, a lost reply never read as success, and where an outcome goes. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAME_MAX, type HistoryRow, type OverlayOp, type OverlayResult } from '../../../src/shared/ipc.ts';
import { allPages, draftError, draftOf, folderChoices, moveFocus, moveText, openPhase, pickProject, routeMove, runMove, type MoveDraft } from '../../../src/renderer/history/move.ts';

const hrow = (id: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({ id, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable',
  cwd: null, title: null, lastActivity: 1, drift: false, compressed: false, quarantined: 0, live: null, contextPct: null, costUsd: null,
  costCoverage: 'unavailable', tokens: null, tokensComplete: false, project: null, folder: null, pinned: false, archivedAt: null,
  trashedAt: null, trashPurgeAt: null, keep: false, purgeAt: null, ...extra });

/** A fake overlay: records each op and answers from `answers` in order (null = the reply was lost). */
function fake(...answers: (OverlayResult | null)[]) {
  const sent: OverlayOp[] = [];
  return { sent, overlay: (op: OverlayOp) => { sent.push(op); const a = answers.shift(); return a === null || a === undefined ? Promise.reject(new Error('lost')) : Promise.resolve(a); } };
}

test('draftOf: the current project and folder are preselected; none when the session has no override', () => {
  assert.deepEqual(draftOf(hrow(1)), { project: 'none', projectName: '', folder: 'none', folderName: '' });
  assert.deepEqual(draftOf(hrow(1, { project: { id: 3, name: 'P' }, folder: { id: 9, name: 'F' } })), { project: 3, projectName: '', folder: 9, folderName: '' });
});

test('pickProject: another project resets the folder (folders belong to one project)', () => {
  const d: MoveDraft = { project: 3, projectName: '', folder: 9, folderName: '' };
  assert.deepEqual(pickProject(d, 4), { ...d, project: 4, folder: 'none' });
  assert.deepEqual(pickProject(d, 3), d, 'the same project keeps its folder');
});

test('draftError: a new project or folder needs a name of 1..NAME_MAX characters after trimming', () => {
  const base: MoveDraft = { project: 'new', projectName: '  ', folder: 'none', folderName: '' };
  assert.deepEqual(draftError(base), { field: 'projectName', text: 'Enter a project name.' });
  assert.deepEqual(draftError({ ...base, projectName: 'x'.repeat(NAME_MAX + 1) }), { field: 'projectName', text: `Use at most ${NAME_MAX} characters.` });
  assert.equal(draftError({ ...base, projectName: ` ${'x'.repeat(NAME_MAX)} ` }), null);
  assert.deepEqual(draftError({ project: 2, projectName: '', folder: 'new', folderName: '' }), { field: 'folderName', text: 'Enter a folder name.' });
  assert.equal(draftError({ project: 'none', projectName: '', folder: 'none', folderName: '' }), null, 'No project is a valid target');
});

test('runMove: an existing target sends one move op', async () => {
  const f = fake({ ok: true });
  assert.equal(await runMove({ project: 3, projectName: '', folder: 9, folderName: '' }, 5, f.overlay), 'moved');
  assert.deepEqual(f.sent, [{ kind: 'move', session: 5, project: 3, folder: 9 }]);
});

test('runMove: No project clears both overrides (a folder never goes without its project)', async () => {
  const f = fake({ ok: true });
  assert.equal(await runMove({ project: 'none', projectName: '', folder: 9, folderName: '' }, 5, f.overlay), 'moved');
  assert.deepEqual(f.sent, [{ kind: 'move', session: 5, project: null, folder: null }]);
});

test('runMove: a new project and a new folder are created first (trimmed names), then the move uses their ids', async () => {
  const f = fake({ ok: true, id: 11 }, { ok: true, id: 22 }, { ok: true });
  assert.equal(await runMove({ project: 'new', projectName: ' Alpha ', folder: 'new', folderName: ' Notes ' }, 5, f.overlay), 'moved');
  assert.deepEqual(f.sent, [{ kind: 'newProject', name: 'Alpha' }, { kind: 'newFolder', project: 11, name: 'Notes' }, { kind: 'move', session: 5, project: 11, folder: 22 }]);
});

test('runMove: a failure stops the sequence and is returned; a lost reply is unavailable, never success', async () => {
  const a = fake({ ok: false, error: 'limit' });
  assert.equal(await runMove({ project: 'new', projectName: 'A', folder: 'none', folderName: '' }, 5, a.overlay), 'limit');
  assert.equal(a.sent.length, 1, 'no move after a failed create');
  const b = fake({ ok: true, id: 11 }, null);
  assert.equal(await runMove({ project: 11, projectName: '', folder: 'new', folderName: 'N' }, 5, b.overlay), 'unavailable');
  assert.equal(b.sent.length, 2);
  const c = fake({ ok: true });
  assert.equal(await runMove({ project: 'new', projectName: 'A', folder: 'none', folderName: '' }, 5, c.overlay), 'unavailable', 'a create without an id is no known result');
  const d = fake({ ok: false, error: 'not-found' });
  assert.equal(await runMove({ project: 3, projectName: '', folder: 'none', folderName: '' }, 5, d.overlay), 'not-found');
});

test('moveText: every outcome in words; failures say nothing was moved; unavailable says Close does not cancel', () => {
  assert.equal(moveText(null), '');
  assert.equal(moveText('applying'), 'Applying changes…');
  assert.equal(moveText('moved'), 'Moved. Only Xaibo\'s organization changed; the working folder and native files are untouched.');
  assert.equal(moveText('invalid'), 'That name cannot be used. Nothing was moved.');
  assert.equal(moveText('limit'), 'Too many projects or folders. Nothing was moved.');
  assert.equal(moveText('not-found'), 'The session, project or folder is no longer available. Nothing was moved.');
  assert.equal(moveText('read-only'), 'Xaibo is read-only. Nothing was moved.');
  assert.equal(moveText('disk-full'), 'The disk is full. Nothing was moved.');
  assert.equal(moveText('store'), 'The change could not be saved. Nothing was moved.');
  assert.equal(moveText('unavailable'), 'The result is unavailable. Closing this dialog does not cancel the operation.');
});

test('routeMove: moved closes the dialog; other results stay in an open dialog (Close only) or go beside the trigger', () => {
  assert.deepEqual(routeMove('moved', true), { close: true, moved: true, refresh: true, dialog: null, note: moveText('moved') });
  assert.deepEqual(routeMove('moved', false), { close: false, moved: true, refresh: true, dialog: null, note: moveText('moved') });
  assert.deepEqual(routeMove('limit', true), { close: false, moved: false, refresh: false, dialog: 'limit', note: null });
  assert.deepEqual(routeMove('unavailable', false), { close: false, moved: false, refresh: true, dialog: null, note: moveText('unavailable') });
});

test('routeMove (review M3): a lost reply or not-found reads the row again, as the plain row actions do; a definite failure does not', () => {
  assert.equal(routeMove('unavailable', true).refresh, true, 'the move may have happened');
  assert.equal(routeMove('not-found', true).refresh, true, 'the session may be gone');
  for (const r of ['invalid', 'limit', 'read-only', 'disk-full', 'store'] as const) assert.equal(routeMove(r, true).refresh, false, r);
});

test('openPhase (review M1): a dialog shows Applying only for the session whose move is still running', () => {
  assert.equal(openPhase(null, 5), null);
  assert.equal(openPhase(5, 5), 'applying');
  assert.equal(openPhase(4, 5), null, 'another session\'s move never shows in this dialog');
});

test('folderChoices (review M2): only the folders of the chosen project; the current folder when that is its project', () => {
  const row = hrow(1, { project: { id: 7, name: 'P' }, folder: { id: 9, name: 'F' } });
  const f7 = { list: [{ id: 3, name: 'A' }], project: 7 };
  assert.deepEqual(folderChoices({ project: 7, projectName: '', folder: 9, folderName: '' }, f7, row), [{ id: 9, name: 'F' }, { id: 3, name: 'A' }]);
  assert.deepEqual(folderChoices({ project: 'new', projectName: 'N', folder: 'none', folderName: '' }, f7, row), [], 'a new project has no folders yet');
  assert.deepEqual(folderChoices({ project: 8, projectName: '', folder: 'none', folderName: '' }, f7, row), [], 'project 7\'s folders never show under 8');
  assert.deepEqual(folderChoices({ project: 8, projectName: '', folder: 'none', folderName: '' }, { list: [{ id: 4, name: 'B' }], project: 8 }, row), [{ id: 4, name: 'B' }]);
});

test('allPages: follows the cursor to the end, bounded by a page cap', async () => {
  const pages: Record<string, { items: number[]; next: number | null }> = { start: { items: [1, 2], next: 2 }, 2: { items: [3], next: null } };
  assert.deepEqual(await allPages((c) => Promise.resolve(pages[c ?? 'start']!)), [1, 2, 3]);
  let calls = 0;
  assert.deepEqual(await allPages((c) => { calls++; return Promise.resolve({ items: [c ?? 0], next: (c ?? 0) + 1 }); }, 3), [0, 1, 2]);
  assert.equal(calls, 3);
});

test('moveFocus (review L1, re-review): only a result that closed its dialog places focus, the empty-list fallback included', () => {
  const closed = { close: true }, late = { close: false };
  assert.deepEqual(moveFocus(closed, 'placed'), { focus: 'record', fallback: true });
  assert.deepEqual(moveFocus(closed, 'left'), { focus: 'heading', fallback: true }, 'with View moved session');
  assert.deepEqual(moveFocus(closed, 'failed'), { focus: 'trigger', fallback: true });
  for (const at of ['placed', 'left', 'failed'] as const) assert.deepEqual(moveFocus(late, at), { focus: null, fallback: false }, at);
});
