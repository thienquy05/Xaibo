// Gate 6 Codex round 1 fixes (owner "go"): G6E-2 (XAIBO-PROD-604) the folder-descendant filter counts the prefix in
// characters as SQLite substr does, so an astral character keeps descendants; G6D1-1 (XAIBO-PROD-605) refreshing the Agents
// list refetches the resident window in sequence from fresh cursors, so a row inserted before a page boundary hides nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { scopeWhere } from '../../src/service/history/overlay.ts';
import { refreshWindow } from '../../src/renderer/agent-map/integrations-state.ts';
import { pageArrived, emptyLevel } from '../../src/renderer/agent-map/tree.ts';
import type { IntegrationKey, IntegrationPageResult, IntegrationRow } from '../../src/shared/ipc.ts';

test('G6E-2: an astral character in the folder keeps its descendants (SQLite substr counts characters)', () => {
  const folder = '/tmp/xaibo-fixture/w' + String.fromCodePoint(0x1f600);
  const { where, args } = scopeWhere({ mode: 'all', agent: null, project: null, folder: null, cwd: folder }, false);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY, cwd TEXT, agent TEXT)');
  for (const [i, c] of [folder, folder + '/sub', folder + 'x', '/tmp/xaibo-fixture/other'].entries()) db.prepare('INSERT INTO sessions (id, cwd, agent) VALUES (?, ?, ?)').run(i + 1, c, 'claude');
  const ids = db.prepare(`SELECT id FROM sessions s WHERE ${where.join(' AND ')} ORDER BY id`).all(...args).map((r) => (r as { id: number }).id);
  assert.deepEqual(ids, [1, 2], 'the folder and its descendant; never a sibling with the same prefix');
});

const row = (agent: string) => ({ key: { agent, profileId: null } }) as unknown as IntegrationRow;
function lister(names: string[]) {
  return async (cursor: IntegrationKey | null, limit: number): Promise<IntegrationPageResult> => {
    const i = cursor === null ? 0 : names.indexOf(cursor.agent) + 1;
    const rows = names.slice(i, i + limit).map(row);
    return { status: 'ready', observedAt: 7, value: { rows, previous: null, next: i + limit < names.length ? rows.at(-1)!.key : null } };
  };
}

test('G6D1-1: a refresh after an insertion before a page boundary loses no row (fresh cursors, in sequence)', async () => {
  const names = Array.from({ length: 25 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`);
  const fetch = lister(names);
  const p1 = await fetch(null, 10), p2 = await fetch((p1 as { value: { next: IntegrationKey } }).value.next, 10);
  let l = pageArrived(emptyLevel(), 'first', null, (p1 as { value: { rows: IntegrationRow[] } }).value.rows, (p1 as { value: { next: IntegrationKey } }).value.next);
  l = pageArrived(l, 'more', (p1 as { value: { next: IntegrationKey } }).value.next, (p2 as { value: { rows: IntegrationRow[] } }).value.rows, (p2 as { value: { next: IntegrationKey | null } }).value.next);
  names.splice(5, 0, 'a05x'); // inserted on page one: its last row moves to page two
  const out = await refreshWindow(l, lister(names));
  assert.ok(out, 'refreshed');
  const shown = out!.level.pages.flatMap((p) => p.items.map((r) => r.key.agent));
  assert.deepEqual(shown, names.slice(0, 20), 'every row up to the window end, none skipped');
  assert.equal(out!.level.pages.length, 2);
  assert.deepEqual(out!.level.next, { agent: names[19], profileId: null });
  assert.equal(await refreshWindow(l, async () => ({ status: 'refused', code: 'stale-cursor' })), null, 'a refusal: the caller starts over');
});
