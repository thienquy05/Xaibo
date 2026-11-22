// XAIBO-PROD-508 (P5-T02b, D-P5-03): Codex thread names from <CODEX_HOME>/session_index.jsonl ({id, thread_name,
// updated_at} per line; Codex 0.160.0 rewrites it through session_index.jsonl.tmp + rename) become session titles.
// The index is read only, re-read when it changes, never creates a session and never becomes a source file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { listSessions } from '../../src/service/api.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { count, until } from '../helpers/claude-profile.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0', 'simple-turn');
const FIXTURE_ID = '0000000c0030';
const sid = (n: string) => `00000000-0000-4000-8000-0000000c${n}`;
const entry = (id: string, name: unknown) => JSON.stringify({ id, thread_name: name, updated_at: '2026-01-01T00:00:00.000Z' });

const titles = (db: DatabaseSync) => {
  const ids = new Map((db.prepare('SELECT id, native_session_id AS n FROM sessions').all() as { id: number; n: string }[]).map((r) => [r.id, r.n]));
  return Object.fromEntries(listSessions(db, null, 50, [], []).rows.map((r) => [ids.get(r.id), r.title]));
};

test('Codex thread names: titles from session_index.jsonl; rename by tmp + rename; last line wins; never creates sessions or touches the index', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xcodex-title-'));
  const root = join(tmp, 'codex');
  const dated = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  const name = readdirSync(FIX).find((f) => f.startsWith('rollout-'))!;
  const fixture = readFileSync(join(FIX, name), 'utf8');
  const rollout = (n: string) => writeFileSync(join(dated, name.replace(FIXTURE_ID, `0000000c${n}`)), fixture.replaceAll(FIXTURE_ID, `0000000c${n}`));
  copyFileSync(join(FIX, name), join(dated, name)); // session 0030
  rollout('0031');
  const index = join(root, 'session_index.jsonl');
  const rewrite = (...lines: string[]) => { writeFileSync(`${index}.tmp`, lines.join('\n')); renameSync(`${index}.tmp`, index); };
  rewrite(
    entry(sid('0030'), 'First name'), 'not json', entry(sid('0031'), ''), entry(sid('0031'), 7),
    entry(sid('0099'), 'Not ingested'), // no rollout: never becomes a session
    entry(sid('0030'), 'Thread one') + '\n', // last line wins
  );
  const fp = () => `${createHash('sha256').update(readFileSync(index)).digest('hex')}:${statSync(index).mtimeMs}`;

  const { db } = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', ?, 'default')").run(root);
  const a = new CodexAdapter({ db, writer: new Writer(db), profileId: 'p1', root, intervalMs: 60_000 });
  const before = fp();
  await a.start();
  assert.deepEqual(titles(db), { [sid('0030')]: 'Thread one', [sid('0031')]: null });
  assert.equal(count(db, 'SELECT count(*) FROM sessions'), 2, 'an index entry never creates a session');
  assert.equal(fp(), before, 'index content and mtime unchanged');

  // Rename in Codex: the whole index is rewritten through a temp file and a rename; a partial trailing line is skipped.
  rewrite(entry(sid('0030'), 'Thread one renamed'), entry(sid('0031'), 'Thread two') + '\n' + '{"id":"' + sid('0032'));
  await a.wake();
  assert.deepEqual(titles(db), { [sid('0030')]: 'Thread one renamed', [sid('0031')]: 'Thread two' });

  // A rollout that appears after the index was read takes its name.
  rewrite(entry(sid('0030'), 'Thread one renamed'), entry(sid('0031'), 'Thread two'), entry(sid('0032'), 'Thread three') + '\n');
  await a.wake();
  rollout('0032');
  await a.backfill(); // awaits each file's sync (a scan only starts them)
  a.stop();
  assert.equal(titles(db)[sid('0032')], 'Thread three');
  assert.equal(count(db, "SELECT count(*) FROM source_files WHERE path LIKE '%session_index%'"), 0, 'never a source file');
});

/** A Codex home with the simple-turn rollout for each session suffix, and a store. */
async function home(sessions: string[], hold?: { fn: (() => void) | null; on: boolean }) {
  const tmp = mkdtempSync(join(tmpdir(), 'xcodex-title-'));
  const root = join(tmp, 'codex');
  const dated = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  const name = readdirSync(FIX).find((f) => f.startsWith('rollout-'))!;
  const fixture = readFileSync(join(FIX, name), 'utf8');
  const rollout = (n: string) => {
    const p = join(dated, name.replace(FIXTURE_ID, `0000000c${n}`));
    writeFileSync(p, fixture.replaceAll(FIXTURE_ID, `0000000c${n}`));
    return p;
  };
  for (const n of sessions) rollout(n);
  const { db } = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', ?, 'default')").run(root);
  const writer = new Writer(db, hold ? { setTimer: (fn, ms) => { if (hold.on) hold.fn = fn; else setTimeout(fn, ms); } } : {});
  return { tmp, root, db, rollout, a: new CodexAdapter({ db, writer, profileId: 'p1', root, intervalMs: 60_000 }) };
}

test('review M1: a symlinked index is not followed (only the regular file Codex writes is read)', async () => {
  const h = await home(['0030']);
  writeFileSync(join(h.tmp, 'elsewhere.jsonl'), entry(sid('0030'), 'Via symlink') + '\n');
  symlinkSync(join(h.tmp, 'elsewhere.jsonl'), join(h.root, 'session_index.jsonl'));
  await h.a.start();
  h.a.stop();
  assert.deepEqual(titles(h.db), { [sid('0030')]: null });
});

test('review M2: a backfill rollout batch built while the title batch waits in the same flush still gets the name', async () => {
  const hold = { fn: null as (() => void) | null, on: false };
  const h = await home([], hold);
  await h.a.start();
  writeFileSync(join(h.root, 'session_index.jsonl'), entry(sid('0040'), 'Raced name') + '\n');
  hold.on = true;
  const scan = h.a.wake(); // reads the index; its title batch waits for the held timer
  await until(() => hold.fn !== null, 5000);
  const path = h.rollout('0040');
  await h.a.sync({ path, kind: 'rollout', sessionId: sid('0040'), archived: false, compressed: false }, false); // flushes both
  hold.on = false;
  await scan;
  h.a.stop();
  assert.deepEqual(titles(h.db), { [sid('0040')]: 'Raced name' });
});
