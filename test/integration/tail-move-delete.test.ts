// XAIBO-PROD-520 (P5-T13; EC-71): a session file moved or deleted while it is tailed. The agent keeps writing through
// its open fd while the file is renamed out of discovery, moved to another project folder, or unlinked. The watcher
// closes cleanly: every handle on a vanished path is released (open handles back to the still-listed active files,
// the P4-T10 watched() metric), availability follows (gone -> native deleted, moved within discovery -> available,
// records continue from the new path, none twice), and nothing crash-loops (no uncaught error = no service restart,
// no re-reads of a vanished path) over at least 60 reconciliation scans. A file replaced at the same path (unlink, then a
// new file) gets a fresh watch: a watch follows the inode, so the old handle would watch a dead file. The replace case
// relies on a new inode number (APFS, the shipped target); a filesystem that reuses it at once (ext4, tmpfs) keeps the
// old watch until the file goes inactive, with the scan still reporting changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, closeSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, watch as fsWatch, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import type { ClaudeFile } from '../../src/service/adapters/claude/discover.ts';
import type { Closable } from '../../src/service/watch.ts';
import { claudeProfile, count, until } from '../helpers/claude-profile.ts';

const sid = (i: number) => `00000000-0000-4000-8000-0000000c${String(i).padStart(4, '0')}`;
const uuid = (i: number, k: number) => `00000000-0000-4000-8000-${String(i).padStart(4, '0')}${String(k).padStart(8, '0')}`;
const rec = (i: number, k: number) => `${JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uuid(i, k), timestamp: new Date().toISOString(),
  cwd: '/tmp/xaibo-fixture/ec71', sessionId: sid(i), version: '2.1.319', entrypoint: 'cli', message: { role: 'user', content: `prompt ${k}` } })}\n`;
const stored = (db: DatabaseSync, i: number) => count(db, 'SELECT count(*) FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.native_session_id = ?', sid(i));
const avail = (db: DatabaseSync, i: number) => count(db, 'SELECT native_available FROM sessions WHERE native_session_id = ?', sid(i));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real fs.watch handles, counted per path. */
function watches() {
  const open = new Map<string, number>();
  let opens = 0;
  const total = () => [...open.values()].reduce((a, b) => a + b, 0);
  const watch = (path: string, fn: () => void): Closable => {
    const w = fsWatch(path, { persistent: false }, fn);
    open.set(path, (open.get(path) ?? 0) + 1);
    opens++;
    let closed = false;
    return { close: () => { if (!closed) { closed = true; open.set(path, open.get(path)! - 1); w.close(); } }, on: (ev, f) => w.on(ev, f) };
  };
  return { watch, open, total, opens: () => opens };
}

class Counted extends ClaudeAdapter {
  scans = 0;
  protected override async discover(): Promise<ClaudeFile[]> { this.scans++; return super.discover(); }
}

/** Uncaught errors while `fn` runs: any one would exit the service process (a supervisor restart). */
async function noCrash(fn: () => Promise<void>): Promise<unknown[]> {
  const errors: unknown[] = [];
  const on = (e: unknown) => errors.push(e);
  process.on('uncaughtException', on);
  process.on('unhandledRejection', on);
  try { await fn(); } finally { process.off('uncaughtException', on); process.off('unhandledRejection', on); }
  return errors;
}

test('EC-71: tailed files renamed out, moved within and unlinked under load: handles released, availability updated, no crash loop', async () => {
  const p = await claudeProfile([]);
  const dirA = join(p.root, 'projects', '-tmp-xaibo-fixture-ec71'), dirB = join(p.root, 'projects', '-tmp-xaibo-fixture-ec71b'), aside = join(p.tmp, 'aside');
  for (const d of [dirA, dirB, aside]) mkdirSync(d, { recursive: true });
  const A = realpathSync(dirA), B = realpathSync(dirB); // discovery reports real paths (macOS temp dir symlink)
  const N = 12, stay = [0, 1, 2, 3], out = [4, 5, 6], within = [7, 8], gone = [9, 10, 11];
  const path = Array.from({ length: N }, (_, i) => join(A, `${sid(i)}.jsonl`));
  const written = new Array<number>(N).fill(1);
  for (let i = 0; i < N; i++) writeFileSync(path[i]!, rec(i, 1));
  const w = watches();
  const a = new Counted({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 100, watch: w.watch });
  const fds = path.map((f) => openSync(f, 'a')); // the agent's own handles: writes go on after a rename or unlink
  let load: NodeJS.Timeout | undefined;
  const errors = await noCrash(async () => {
    await a.start();
    try {
      await until(() => w.total() === N, 3_000);
      let n = 0;
      load = setInterval(() => { const i = n++ % N; if (fds[i] !== -1) writeSync(fds[i]!, rec(i, ++written[i]!)); }, 2);
      await sleep(500);
      const vanished = [...out.map((i) => path[i]!), ...within.map((i) => path[i]!), ...gone.map((i) => path[i]!)];
      for (const i of out) renameSync(path[i]!, join(aside, `${sid(i)}.jsonl`));
      for (const i of within) renameSync(path[i]!, join(B, `${sid(i)}.jsonl`));
      for (const i of gone) unlinkSync(path[i]!);
      const scans0 = a.scans;
      await sleep(3_000); // under load
      clearInterval(load);
      for (let i = 0; i < N; i++) { closeSync(fds[i]!); fds[i] = -1; }
      const reads = vanished.map((f) => a.reads(f));
      await until(() => a.scans - scans0 >= 60, 30_000); // review L: bounded, a stalled scan fails instead of hanging
      // the guarantee holds from the sweep on (re-reads inside the load window, before it, are expected)
      assert.deepEqual(vanished.map((f) => a.reads(f)), reads, 'no vanished path is read again');
      for (const f of vanished) assert.equal(w.open.get(f) ?? 0, 0, `the watch on a vanished path is released (${f.slice(-12)})`);
      assert.equal(w.total(), stay.length + within.length, 'open handles back to the still-listed active files');
      assert.equal(a.watched(), w.total(), 'the watched() metric matches the real handles');
      for (const i of [...out, ...gone]) assert.equal(avail(p.db, i), 0, `session ${i} reads native deleted`);
      for (const i of [...stay, ...within]) assert.equal(avail(p.db, i), 1, `session ${i} stays available`);
      await until(() => [...stay, ...within].every((i) => stored(p.db, i) === written[i]), 5_000); // moved files continue from the new path
      assert.equal(count(p.db, 'SELECT count(*) FROM events'), count(p.db, 'SELECT count(DISTINCT session_id || native_id) FROM events'), 'no event twice');
    } finally { clearInterval(load); a.stop(); for (const fd of fds) if (fd !== -1) closeSync(fd); }
  });
  assert.deepEqual(errors, [], 'no uncaught error (no service restart)');
  assert.equal(w.total(), 0, 'stop closes every handle');
});

const replaceSkip = process.platform !== 'darwin' && 'inode numbers are reused at once off macOS (S-23)'; // see the header
test('EC-71: a tailed file replaced at the same path gets a fresh watch; the handle on the dead file is closed', { skip: replaceSkip }, async () => {
  const p = await claudeProfile([]);
  const dir = join(p.root, 'projects', '-tmp-xaibo-fixture-ec71r');
  mkdirSync(dir, { recursive: true });
  const f = join(realpathSync(dir), `${sid(50)}.jsonl`);
  writeFileSync(f, rec(50, 1));
  const w = watches();
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000, watch: w.watch });
  const errors = await noCrash(async () => {
    await a.start();
    try {
      assert.equal(w.total(), 1);
      assert.equal(stored(p.db, 50), 1);
      unlinkSync(f);
      writeFileSync(f, rec(50, 2)); // a new file (new inode) at the same path
      await a.wake();
      assert.equal(w.opens(), 2, 'the replaced file got a fresh watch');
      assert.equal(w.total(), 1, 'the handle on the dead file is closed');
      await until(() => stored(p.db, 50) === 2, 10_000);
      appendFileSync(f, rec(50, 3)); // the watch alone stores it: no wake, no scan (60 s interval)
      await until(() => stored(p.db, 50) === 3, 10_000);
    } finally { a.stop(); }
  });
  assert.deepEqual(errors, []);
  assert.equal(w.total(), 0);
});
