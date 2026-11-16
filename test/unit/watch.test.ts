// XAIBO-PROD-423 (P4-T10a; S12 watcher strategy, FR-02): at most maxWatched fs.watch handles; at the cap the least
// recently active watched file is dropped for a newer active one (S12: least-recently-active first); an older one stays
// to the scan. Equal activity never churns. watched() is the open handle count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Watcher, type Closable } from '../../src/service/watch.ts';

function files(n: number, ageMs: (i: number) => number, now: number) {
  const dir = mkdtempSync(join(tmpdir(), 'xwatch-'));
  return Array.from({ length: n }, (_, i) => {
    const path = join(dir, `f${i}.jsonl`);
    writeFileSync(path, 'x\n');
    const t = (now - ageMs(i)) / 1000;
    utimesSync(path, t, t);
    return { path };
  });
}

function fakeWatch() {
  const open = new Set<string>();
  let max = 0;
  const watch = (p: string): Closable => {
    open.add(p);
    max = Math.max(max, open.size);
    return { close: () => { open.delete(p); }, on: () => undefined };
  };
  return { open, watch, max: () => max };
}

test('at the cap the least recently active watched file is dropped for a newer one; never above the cap', async () => {
  const now = Date.now();
  const f = files(5, (i) => (5 - i) * 10_000, now); // f0 oldest ... f4 newest, all active
  const w = fakeWatch();
  const watcher = new Watcher({ list: async () => f, onChange: () => undefined, maxWatched: 2, watch: w.watch, now: () => now });
  await watcher.start();
  watcher.stop();
  assert.deepEqual([...w.open].sort(), [], 'stop closes every handle');
  assert.ok(w.max() <= 2, `never above the cap (max ${w.max()})`);

  const w2 = fakeWatch();
  const watcher2 = new Watcher({ list: async () => f, onChange: () => undefined, maxWatched: 2, watch: w2.watch, now: () => now });
  await watcher2.start();
  assert.deepEqual([...w2.open].map((p) => p.slice(-8)).sort(), ['f3.jsonl', 'f4.jsonl'], 'the two most recently active files');
  assert.equal(watcher2.watched(), 2);
  assert.ok(w2.max() <= 2);
  watcher2.stop();
});

test('an older active file never displaces a newer watched one; equal activity does not churn', async () => {
  const now = Date.now();
  const newer = files(2, () => 1000, now);
  const older = files(1, () => 60_000, now);
  const w = fakeWatch();
  let opens = 0;
  const watch = (p: string) => { opens++; return w.watch(p); };
  const list = [...newer, ...older];
  const watcher = new Watcher({ list: async () => list, onChange: () => undefined, maxWatched: 2, watch, now: () => now });
  await watcher.start();
  await watcher.scan();
  await watcher.scan();
  assert.deepEqual([...w.open].sort(), newer.map((x) => x.path).sort());
  assert.equal(opens, 2, 'no handle reopened across scans');
  watcher.stop();
});

test('review M2: a watch event refreshes its file activity, so a busy watched file is not evicted by an older one', async () => {
  const now = Date.now();
  const [a] = files(1, () => 20_000, now);
  const [b] = files(1, () => 10_000, now);
  const callbacks = new Map<string, () => void>();
  const open = new Set<string>();
  const watch = (p: string, fn: () => void): Closable => { callbacks.set(p, fn); open.add(p); return { close: () => { open.delete(p); }, on: () => undefined }; };
  const list = [a!];
  const watcher = new Watcher({ list: async () => list, onChange: () => undefined, maxWatched: 1, watch, now: () => now });
  await watcher.start();
  assert.deepEqual([...open], [a!.path]);
  callbacks.get(a!.path)!(); // A is busy: a change arrives through its watch, before the next scan
  list.push(b!); // B (10 s old) appears; A was stored at 20 s old but has just changed
  await watcher.scan();
  assert.deepEqual([...open], [a!.path], 'A keeps its watch');
  watcher.stop();
});

test('an unwatched file is still reported by the scan when it changes', async () => {
  const now = Date.now();
  const f = files(3, (i) => (3 - i) * 10_000, now);
  const w = fakeWatch();
  const changed: string[] = [];
  const watcher = new Watcher({ list: async () => f, onChange: (e) => changed.push(e.path), maxWatched: 1, watch: w.watch, now: () => now });
  await watcher.start();
  writeFileSync(f[0]!.path, 'x\ny\n'); // the oldest, not watched
  await watcher.scan();
  assert.deepEqual(changed, [f[0]!.path]);
  watcher.stop();
});
