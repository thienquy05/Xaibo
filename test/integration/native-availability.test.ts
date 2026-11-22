// XAIBO-PROD-519 (P5-T12; EC-23, EC-24, FR-13): native availability for Claude and Codex, checked on every adapter scan
// independently of Xaibo retention. A deleted transcript or rollout (cleanup, `claude purge`, `codex delete`) keeps every
// Xaibo row; the session reads native deleted, "Transcript only, not resumable", resume disabled with a reason. A Codex
// archive (move to archived_sessions/) keeps content and the session available, marked archived. A restored file makes
// the session available again. Nothing is ever created at a vanished native path. The Claude cleanup date is an
// estimate: newest transcript mtime + effective cleanupPeriodDays (managed wins over user; 30 when unset).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { answerSession, listSessions } from '../../src/service/api.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { loadCatalog } from '../../src/service/catalog/validate.ts';
import { resumeArgv } from '../../src/service/resume.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import * as ipc from '../../src/shared/ipc.ts';
import { claudeProfile, count } from '../helpers/claude-profile.ts';

const DAY = 86_400_000;
const CLAUDE_SID = '00000000-0000-4000-8000-000000002000'; // identifiers fixture: a main transcript plus one subagent file
const kinds = loadCatalog().sessionKinds;

async function claude() {
  const p = await claudeProfile(['identifiers']);
  const dir = join(p.root, 'projects', '-tmp-xaibo-fixture-identifiers');
  const main = join(dir, `${CLAUDE_SID}.jsonl`);
  const sub = join(dir, CLAUDE_SID, 'subagents', 'agent-00000000-0000-4000-8000-000000002100.jsonl');
  const scan = async () => { const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  await scan();
  return { ...p, dir, main, sub, scan };
}

type Native = { available: boolean; archived: boolean };
const rowOf = (db: DatabaseSync, agent: string) => listSessions(db, null, 50, kinds).rows.find((r) => r.agent === agent)! as ipc.SessionRow & { native?: Native };
const events = (db: DatabaseSync) => count(db, 'SELECT count(*) FROM events');
const shared = ipc as unknown as { nativeBadge?: (n: Native) => string | null; TRANSCRIPT_ONLY?: string };
type Detail = { nativeExpiresAt?: number | null } | null;

test('EC-23/EC-24: a deleted Claude transcript keeps Xaibo content; native deleted, transcript only, resume disabled; restored -> available', async () => {
  const p = await claude();
  const n = events(p.db);
  assert.ok(n > 0);
  assert.deepEqual(rowOf(p.db, 'claude').native, { available: true, archived: false });
  const aside = join(p.tmp, 'aside.jsonl');
  renameSync(p.main, aside); // `claude purge` or cleanup: the native transcript is gone
  await p.scan();
  const row = rowOf(p.db, 'claude');
  assert.deepEqual(row.native, { available: false, archived: false });
  assert.equal(events(p.db), n, "Xaibo's copy stays");
  assert.equal(shared.nativeBadge?.(row.native!), 'native deleted');
  assert.equal(shared.TRANSCRIPT_ONLY, 'Transcript only, not resumable');
  const r = resumeArgv(kinds, { agent: 'claude', entrypoint: null, originator: null, nativeSessionId: CLAUDE_SID, nativeAvailable: row.native!.available });
  assert.ok('disabled' in r && r.reason.length > 0, 'resume disabled with a reason');
  await p.scan();
  assert.equal(existsSync(p.main), false, 'nothing recreated at the native path');
  assert.equal(events(p.db), n, 'repeated scans change nothing');
  renameSync(aside, p.main);
  await p.scan();
  assert.deepEqual(rowOf(p.db, 'claude').native, { available: true, archived: false }, 'restored');
  assert.equal(events(p.db), n);
});

test('EC-24: deleting only a subagent file leaves the session available', async () => {
  const p = await claude();
  rmSync(p.sub);
  await p.scan();
  assert.deepEqual(rowOf(p.db, 'claude').native, { available: true, archived: false });
});

test('EC-23: the session detail carries the Claude cleanup estimate: user setting, managed wins, default 30, unreadable -> none', async () => {
  const p = await claude();
  const managed = join(p.tmp, 'managed');
  mkdirSync(managed);
  const id = rowOf(p.db, 'claude').id;
  const detail = (dir: string) => (answerSession as (...a: unknown[]) => { detail: Detail })(p.db, { v: 1, type: 'session', id: 1, session: id }, kinds, [], undefined, dir).detail;
  const expiry = () => detail(managed)?.nativeExpiresAt;
  // the transcript checkpoint mtime is the age basis (S9 left mtime vs last record unverified: shown as an estimate)
  const at = (days: number) => Math.floor(count(p.db, "SELECT max(mtime) FROM source_files WHERE session_id = ? AND kind = 'transcript'", id)) + days * DAY;
  assert.ok(Math.abs(at(0) - statSync(p.main).mtimeMs) < 1000);
  assert.equal(expiry(), at(30), 'unset -> the 30-day agent default');
  writeFileSync(join(p.root, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 45 }));
  assert.equal(expiry(), at(45), 'user setting');
  writeFileSync(join(managed, 'managed-settings.json'), JSON.stringify({ cleanupPeriodDays: 60 }));
  assert.equal(expiry(), at(60), 'managed policy wins');
  writeFileSync(join(managed, 'managed-settings.json'), '{ not json');
  assert.equal(expiry(), null, 'unreadable settings: no estimate');
  writeFileSync(join(managed, 'managed-settings.json'), JSON.stringify({ cleanupPeriodDays: 0 }));
  assert.equal(expiry(), null, 'a non-positive value: no estimate');
  rmSync(join(managed, 'managed-settings.json'));
  renameSync(p.main, join(p.tmp, 'aside.jsonl'));
  await p.scan();
  assert.equal(expiry(), null, 'deleted: nothing left to expire');
});

async function codex() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xna-')));
  const store = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  const db = store.db;
  const writer = new Writer(db);
  const root = join(tmp, '.codex');
  const sid = '00000000-0000-4000-8000-0000000c1201';
  const name = `rollout-2026-01-01T00-00-00-${sid}.jsonl`;
  const live = join(root, 'sessions', '2026', '01', '01', name);
  const archived = join(root, 'archived_sessions', name);
  mkdirSync(join(root, 'sessions', '2026', '01', '01'), { recursive: true });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('c1', 'codex', ?, 'manual')").run(root);
  const ts = '2026-01-01T00:00:00.000Z';
  writeFileSync(live, [
    { timestamp: ts, type: 'session_meta', payload: { id: sid, timestamp: ts, cwd: '/tmp/xaibo-fixture/native', originator: 'codex-tui', cli_version: '0.160.0', source: 'cli' } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic prompt' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const scan = async () => { const a = new CodexAdapter({ db, writer, profileId: 'c1', root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  await scan();
  return { tmp, db, root, live, archived, scan };
}

test('EC-24: codex archive keeps content and the session available, marked archived; codex delete -> native deleted', async () => {
  const c = await codex();
  const n = events(c.db);
  assert.ok(n > 0);
  mkdirSync(join(c.root, 'archived_sessions'));
  renameSync(c.live, c.archived); // `codex archive`
  await c.scan();
  const row = rowOf(c.db, 'codex');
  assert.deepEqual(row.native, { available: true, archived: true });
  assert.equal(shared.nativeBadge?.(row.native!), 'native archived');
  assert.equal(existsSync(c.live), false, 'the old path is not recreated');
  const d = (answerSession as (...a: unknown[]) => { detail: Detail })(c.db, { v: 1, type: 'session', id: 1, session: row.id }, kinds, [], undefined, join(c.tmp, 'no-managed')).detail;
  assert.equal(d?.nativeExpiresAt, null, 'no estimate for Codex');
  rmSync(c.archived); // `codex delete`
  await c.scan();
  assert.deepEqual(rowOf(c.db, 'codex').native, { available: false, archived: true });
  assert.equal(shared.nativeBadge?.(rowOf(c.db, 'codex').native!), 'native deleted');
  assert.ok(events(c.db) >= n, "Xaibo's copy stays");
  assert.equal(existsSync(c.archived) || existsSync(c.live), false, 'nothing recreated');
});

test('IPC: SessionRow.native and SessionDetail.nativeExpiresAt survive the port parser; malformed values are refused', async () => {
  const p = await claude();
  const id = rowOf(p.db, 'claude').id;
  const msg = (answerSession as (...a: unknown[]) => unknown)(p.db, { v: 1, type: 'session', id: 7, session: id }, kinds, [], undefined, join(p.tmp, 'no-managed'));
  const wire = JSON.parse(JSON.stringify(msg)) as { detail: { row: { native: unknown }; nativeExpiresAt: unknown } };
  const parsed = ipc.parsePortMessage(wire) as { detail: { row: { native?: Native }; nativeExpiresAt?: number | null } | null } | null;
  assert.ok(parsed?.detail);
  assert.deepEqual(parsed.detail.row.native, { available: true, archived: false });
  assert.equal(typeof parsed.detail.nativeExpiresAt, 'number');
  wire.detail.row.native = { available: 'yes', archived: false };
  assert.equal(ipc.parsePortMessage(wire), null);
});

// security review M1: a rollout whose session_meta id differs from its file name (quarantined as a mismatch) is present
test('review M1: a present rollout whose file name id differs from its session id is not marked deleted', async () => {
  const c = await codex();
  const meta = '00000000-0000-4000-8000-0000000c1299';
  const fileSid = `00000000-0000-4000-8000-0000000c${1202}`; // the id in the file name, not the session's
  const odd = join(c.root, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${fileSid}.jsonl`);
  const ts = '2026-01-01T00:00:00.000Z';
  writeFileSync(odd, `${JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: meta, timestamp: ts, cwd: '/tmp/xaibo-fixture/odd', originator: 'codex-tui', cli_version: '0.160.0', source: 'cli' } })}\n`);
  await c.scan();
  await c.scan();
  // re-review: the session keyed by its session_meta id (not the file name id) is the one that must read available
  assert.equal(count(c.db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', meta), 1);
  assert.equal(count(c.db, 'SELECT native_available IS NOT 0 FROM sessions WHERE native_session_id = ?', meta), 1, 'present on disk');
  const rows = listSessions(c.db, null, 50, kinds).rows as (ipc.SessionRow & { native?: Native })[];
  for (const r of rows) assert.equal(r.native?.available, true, `session ${r.id} is present on disk`);
});

// security review M2/L1: availability lives on the session; a vanished file's checkpoint (and its coverage status) stays
test('review M2: a deleted and restored file keeps its checkpoint status (compressed/oversized coverage is not lost)', async () => {
  const p = await claude();
  const key = realpathSync(p.main); // the store keeps realpaths (EC-18)
  assert.equal(p.db.prepare("UPDATE source_files SET status = 'oversized' WHERE path = ?").run(key).changes, 1);
  const cp = () => ({ ...p.db.prepare('SELECT status, offset, size, mtime, epoch FROM source_files WHERE path = ?').get(key) });
  const before = cp();
  assert.equal(before.status, 'oversized');
  const aside = join(p.tmp, 'aside.jsonl');
  renameSync(p.main, aside);
  await p.scan();
  assert.equal(rowOf(p.db, 'claude').native?.available, false);
  assert.deepEqual(cp(), before, 'checkpoint untouched while gone');
  renameSync(aside, p.main);
  await p.scan();
  assert.equal(rowOf(p.db, 'claude').native?.available, true);
  assert.deepEqual(cp(), before, 'and after the restore');
});

// security review M3: a mass deletion (Claude's own cleanup) is one bounded pass, not one writer wait per session
test('review M3: one scan after 60 rollouts vanish marks all of them without a per-session writer wait', async () => {
  const c = await codex();
  const ts = '2026-01-01T00:00:00.000Z';
  const files: string[] = [];
  for (let i = 0; i < 60; i++) {
    const sid = `00000000-0000-4000-8000-0000000d${String(i).padStart(4, '0')}`;
    const f = join(c.root, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${sid}.jsonl`);
    writeFileSync(f, `${JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: sid, timestamp: ts, cwd: '/tmp/xaibo-fixture/many', originator: 'codex-tui', cli_version: '0.160.0', source: 'cli' } })}\n`);
    files.push(f);
  }
  await c.scan();
  for (const f of files) rmSync(f);
  const t = performance.now();
  await c.scan();
  const ms = performance.now() - t;
  assert.equal(count(c.db, 'SELECT count(*) FROM sessions WHERE native_available = 0'), 60);
  assert.ok(ms < 1500, `scan took ${Math.round(ms)} ms (60 sessions x a 50 ms writer wait would be >= 3 s)`);
});

// security review L3: an expiry beyond the Date range is no estimate, and the port refuses one
test('review L3: a huge cleanupPeriodDays gives no estimate; the parser refuses an out-of-range expiry', async () => {
  const p = await claude();
  const id = rowOf(p.db, 'claude').id;
  writeFileSync(join(p.root, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 99_999_999 }));
  const msg = (answerSession as (...a: unknown[]) => unknown)(p.db, { v: 1, type: 'session', id: 3, session: id }, kinds, [], undefined, join(p.tmp, 'no-managed'));
  const wire = JSON.parse(JSON.stringify(msg)) as { detail: { nativeExpiresAt: unknown } };
  assert.equal(wire.detail.nativeExpiresAt, null);
  wire.detail.nativeExpiresAt = 9e15;
  assert.equal(ipc.parsePortMessage(wire), null);
  wire.detail.nativeExpiresAt = -1;
  assert.equal(ipc.parsePortMessage(wire), null);
});

// re-review MEDIUM-1: a flip reaches open windows through the writer's commit notification, like any committed batch
test('re-review MEDIUM-1: a native availability flip is announced through onCommit with the session key', async () => {
  const p = await claude();
  const seen: string[] = [];
  const writer = new Writer(p.db, { onCommit: (b) => { for (const s of b.sessions) seen.push(`${b.agent}/${b.profileId}/${s.nativeSessionId}`); } });
  const scan = async () => { const a = new ClaudeAdapter({ db: p.db, writer, profileId: 'p1', root: p.root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  const aside = join(p.tmp, 'aside.jsonl');
  renameSync(p.main, aside);
  seen.length = 0;
  await scan();
  assert.ok(seen.includes(`claude/p1/${CLAUDE_SID}`), 'deletion announced');
  seen.length = 0;
  await scan();
  assert.ok(!seen.includes(`claude/p1/${CLAUDE_SID}`), 'a steady scan announces nothing');
  renameSync(aside, p.main);
  await scan();
  assert.ok(seen.includes(`claude/p1/${CLAUDE_SID}`), 'restore announced');
});

// re-review LOW-1: a transcript mtime before 1970 gives no estimate (the renderer would refuse the whole detail)
test('re-review LOW-1: a negative estimate is never produced', async () => {
  const p = await claude();
  const id = rowOf(p.db, 'claude').id;
  p.db.prepare("UPDATE source_files SET mtime = ? WHERE session_id = ? AND kind = 'transcript'").run(-1e12, id);
  const d = (answerSession as (...a: unknown[]) => { detail: Detail })(p.db, { v: 1, type: 'session', id: 1, session: id }, kinds, [], undefined, join(p.tmp, 'no-managed')).detail;
  assert.equal(d?.nativeExpiresAt, null);
});
