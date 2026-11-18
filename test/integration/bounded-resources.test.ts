// XAIBO-PROD-423 (P4-T10a; S12, FR-02, plan P4-T10 I): 200 tailed synthetic files under a watch cap of 20. Open
// fs.watch handles never exceed the cap; a file without a watch is still read from its checkpoint by the scan, so
// every appended record is stored exactly once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, realpathSync, utimesSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import type { Closable } from '../../src/service/watch.ts';
import { claudeProfile, count } from '../helpers/claude-profile.ts';

const N = 200, CAP = 20;
const sid = (i: number) => `00000000-0000-4000-8000-0000000a${String(i).padStart(4, '0')}`;
const uuid = (i: number, k: number) => `00000000-0000-4000-8${k}00-0000000b${String(i).padStart(4, '0')}`;
const rec = (i: number, k: number) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uuid(i, k), timestamp: new Date().toISOString(),
  cwd: '/tmp/xaibo-fixture/bounded', sessionId: sid(i), version: '2.1.319', entrypoint: 'cli', message: { role: 'user', content: `prompt ${k}` } });

test('200 tailed files, watch cap 20: open handles stay within the cap and every record is stored once', async () => {
  const p = await claudeProfile([]);
  const dir = join(p.root, 'projects', '-tmp-xaibo-fixture-bounded');
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir); // discovery reports real paths; macOS reaches the temp dir through a symlink
  const file = (i: number) => join(real, `${sid(i)}.jsonl`);
  const t0 = Date.now() / 1000;
  for (let i = 0; i < N; i++) {
    writeFileSync(file(i), `${rec(i, 1)}\n`);
    utimesSync(file(i), t0 - (N - i), t0 - (N - i)); // distinct activity, all within the active window: file i is i-th oldest
  }
  let open = 0, max = 0, opens = 0;
  const watched = new Set<string>();
  const watch = (path: string, fn: () => void): Closable => {
    const w = fsWatch(path, { persistent: false }, fn);
    max = Math.max(max, ++open);
    opens++;
    watched.add(path);
    let closed = false;
    return { close: () => { if (!closed) { closed = true; open--; watched.delete(path); w.close(); } }, on: (ev, f) => w.on(ev, f) };
  };
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000, maxWatched: CAP, watch });
  await a.start();
  try {
    const stored = () => count(p.db, "SELECT count(*) FROM events WHERE source = 'transcript'");
    assert.equal(stored(), N);
    assert.ok(!watched.has(file(0)), 'the oldest file is left to the scan');
    // Review M1: the oldest file becomes the most recent; the next scan gives it a watch slot by evicting another.
    const before = opens;
    appendFileSync(file(0), `${rec(0, 2)}\n`);
    await a.wake();
    assert.ok(watched.has(file(0)) && opens > before && open <= CAP, 'eviction gave the newly active file a watch within the cap');
    // The watch path alone stores its next record: no wake, no scan (intervalMs is 60 s).
    appendFileSync(file(0), `${rec(0, 3)}\n`);
    const until = Date.now() + 5_000;
    while (count(p.db, 'SELECT count(*) FROM events WHERE native_id = ?', uuid(0, 3)) === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal(count(p.db, 'SELECT count(*) FROM events WHERE native_id = ?', uuid(0, 3)), 1, 'stored through the watch');
    for (let i = 1; i < N; i++) appendFileSync(file(i), `${rec(i, 2)}\n`);
    const end = Date.now() + 15_000;
    while (stored() < 2 * N + 1 && Date.now() < end) { await a.wake(); await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(stored(), 2 * N + 1, 'every appended record stored');
    assert.equal(count(p.db, "SELECT count(DISTINCT native_id) FROM events WHERE source = 'transcript'"), 2 * N + 1, 'none twice');
    assert.ok(max <= CAP, `open watch handles stayed within the cap (max ${max})`);
    assert.ok(open > 0 && open <= CAP);
  } finally { a.stop(); }
  assert.equal(open, 0, 'stop closes every handle');
});
