// XAIBO-PROD-204 (P2-T04, EC-05, EC-50): the catalog maps verified entry points (Claude `entrypoint`; Codex
// `session_meta.source` + `originator`, S6/S7/S9 and the owner audit) to an origin badge and interactive flag; every
// kind lands in one list with its badge, non-interactive sessions are tagged, unknown kinds show the raw value marked
// unverified. Strings with no fixture (audit-only, S7 `cli`) are written as rows, never as invented record shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { listSessions } from '../../src/service/api.ts';
import { loadCatalog } from '../../src/service/catalog/validate.ts';
import { sessionKind } from '../../src/service/resume.ts';
import { originText } from '../../src/renderer/model.ts';
import { visible } from '../../src/renderer/text.ts';
import type { SessionRow } from '../../src/shared/ipc.ts';
import { claudeProfile } from '../helpers/claude-profile.ts';

const kinds = loadCatalog().sessionKinds;
const kind = (agent: string, entrypoint: string | null, originator: string | null = null) => {
  const k = sessionKind(kinds, { agent, entrypoint, originator });
  return k ? { badge: k.badge ?? null, interactive: k.interactive ?? null } : undefined;
};

test('EC-05: every verified entry point maps to its badge and interactive flag', () => {
  assert.deepEqual(kind('claude', 'cli'), { badge: 'CLI', interactive: true });
  assert.deepEqual(kind('claude', 'sdk-cli'), { badge: 'CLI -p', interactive: false });
  assert.deepEqual(kind('claude', 'claude-vscode'), { badge: 'VS Code', interactive: true });
  assert.deepEqual(kind('claude', 'claude-desktop'), { badge: 'Desktop', interactive: true });
  assert.deepEqual(kind('codex', 'cli', 'codex-tui'), { badge: 'CLI', interactive: true });
  assert.deepEqual(kind('codex', 'exec', 'codex_exec'), { badge: 'exec', interactive: false });
  assert.deepEqual(kind('codex', 'vscode', 'codex_vscode'), { badge: 'VS Code', interactive: true });
  assert.deepEqual(kind('codex', 'vscode', 'codex_work_desktop'), { badge: 'Desktop', interactive: true });
});

test('EC-05: unverified strings and pairs stay unknown (S6: originator is client-chosen)', () => {
  assert.equal(kind('codex', 'vscode', 'xaibo-spike'), undefined, 'any app-server client gets source vscode');
  assert.equal(kind('codex', 'cli', null), undefined, 'source without its originator');
  assert.equal(kind('codex', 'exec', 'codex-tui'), undefined, 'mismatched pair');
  for (const s of ['appServer', 'subAgent']) assert.equal(kind('codex', s, null), undefined, `${s} is not an observed source value`);
  assert.equal(kind('claude', 'sdk-ts'), undefined);
  assert.equal(kind('claude', null), undefined);
  assert.equal(kind('codex', 'CLI', 'codex-tui'), undefined, 'exact strings only');
  assert.equal(kind('gemini', 'cli'), undefined, 'unknown agent');
  assert.deepEqual(kind('agy', null), { badge: null, interactive: null }, 'agy transcripts carry no entry point (T00)');
});

test('EC-05/EC-50: fixtures and audit-only kinds land in one list with badge and non-interactive tag', async () => {
  const p = await claudeProfile(['entrypoints']);
  const codexRoot = join(p.tmp, 'codex');
  const dated = join(codexRoot, 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  const fix = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0', 'entrypoints');
  for (const f of readdirSync(fix).filter((x) => x.startsWith('rollout-'))) copyFileSync(join(fix, f), join(dated, f));
  p.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', ?, 'default')").run(codexRoot);
  for (const a of [new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 }),
    new CodexAdapter({ db: p.db, writer: p.writer, profileId: 'p2', root: codexRoot, intervalMs: 60_000 })]) { await a.start(); a.stop(); }
  const row = p.db.prepare('INSERT INTO sessions (agent, profile_id, native_session_id, entrypoint, originator) VALUES (?, ?, ?, ?, ?)');
  const audit: [string, string, string, string, string | null][] = [
    ['claude', 'p1', '00000000-0000-4000-8000-0000000d0001', 'cli', null],
    ['claude', 'p1', '00000000-0000-4000-8000-0000000d0002', 'claude-vscode', null],
    ['claude', 'p1', '00000000-0000-4000-8000-0000000d0003', 'claude-desktop', null],
    ['codex', 'p2', '00000000-0000-4000-8000-0000000d0004', 'vscode', 'codex_vscode'],
    ['codex', 'p2', '00000000-0000-4000-8000-0000000d0005', 'vscode', 'xaibo-spike'],
  ];
  for (const r of audit) row.run(...r);
  const ids = p.db.prepare('SELECT id, native_session_id AS n FROM sessions').all() as { id: number; n: string }[];
  const byId = new Map(ids.map((x) => [x.id, x.n]));
  const { rows } = listSessions(p.db, null, 50, kinds);
  const got = Object.fromEntries(rows.map((r) => [byId.get(r.id), { origin: r.origin, interactive: r.interactive, text: originText(r) }]));
  assert.deepEqual(got, {
    '00000000-0000-4000-8000-000000006000': { origin: 'CLI -p', interactive: false, text: 'CLI -p · Non-interactive' }, // claude -p fixture
    '00000000-0000-4000-8000-0000000c0007': { origin: 'CLI', interactive: true, text: 'CLI' },
    '00000000-0000-4000-8000-0000000c0008': { origin: 'exec', interactive: false, text: 'exec · Non-interactive' },
    '00000000-0000-4000-8000-0000000d0001': { origin: 'CLI', interactive: true, text: 'CLI' },
    '00000000-0000-4000-8000-0000000d0002': { origin: 'VS Code', interactive: true, text: 'VS Code' },
    '00000000-0000-4000-8000-0000000d0003': { origin: 'Desktop', interactive: true, text: 'Desktop' },
    '00000000-0000-4000-8000-0000000d0004': { origin: 'VS Code', interactive: true, text: 'VS Code' },
    '00000000-0000-4000-8000-0000000d0005': { origin: null, interactive: null, text: 'vscode (unverified)' },
  });
});

test('origin text: badge, raw entry point marked unverified (visible form), or a dash', () => {
  const r = (x: Partial<SessionRow>): SessionRow => ({ id: 1, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable', cwd: null,
    title: null, lastActivity: null, drift: false, compressed: false, quarantined: 0, ...x });
  assert.equal(originText(r({})), '—');
  assert.equal(originText(r({ entrypoint: 'a\u001b[31m‮b' })), `${visible('a\u001b[31m‮b')} (unverified)`);
  assert.equal(originText(r({ entrypoint: 'cli', origin: 'CLI', interactive: true })), 'CLI');
  assert.equal(originText(r({ entrypoint: 'x', interactive: false })), 'x (unverified) · Non-interactive');
});
