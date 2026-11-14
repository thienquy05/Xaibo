// XAIBO-PROD-314 (P3-T13b; PRD §5.10, FR-08, EC-82, Q3-9): disk-backed content.upsert assembly. Chunks are private files
// (0700 dirs, 0600 files) under content-chunks/; an item is complete only when every chunk up to the final one is on disk;
// duplicates are idempotent; out-of-order arrival completes once; a quota hit labels the item incomplete and frees its
// bytes; pending bytes are recomputed from disk when the store reopens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openChunks, type ChunkKey } from '../../src/service/adapters/generic/chunks.ts';

const REG = '00000000-0000-4000-8000-0000000c0001';
const key = (o: Partial<ChunkKey> = {}): ChunkKey => ({ registration: REG, producer: 'prod-1', session: 's-1', item: 'item-1', revision: 1, ...o });
const fresh = () => join(realpathSync(mkdtempSync(join(tmpdir(), 'xc-'))), 'content-chunks');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return lstatSync(p).isDirectory() ? [p, ...walk(p)] : [p]; });

test('in-order chunks: pending until the final one, then complete with the exact text', () => {
  const s = openChunks(fresh());
  assert.equal(s.put(key(), 0, false, 'héllo ').state, 'pending');
  assert.equal(s.put(key(), 1, false, '世界 ').state, 'pending');
  const r = s.put(key(), 2, true, '🙂');
  assert.equal(r.state, 'complete');
  assert.equal(r.state === 'complete' && r.content, 'héllo 世界 🙂');
  assert.equal(r.chunks, 3);
  assert.equal(r.bytes, Buffer.byteLength('héllo 世界 🙂'));
});

test('out of order and duplicated: completes exactly once, duplicates change nothing', () => {
  const s = openChunks(fresh());
  assert.equal(s.put(key(), 2, true, 'c').state, 'pending');
  assert.equal(s.put(key(), 0, false, 'a').state, 'pending');
  assert.equal(s.put(key(), 0, false, 'DIFFERENT').state, 'pending', 'a chunk already on disk is kept as first written');
  const r = s.put(key(), 1, false, 'b');
  assert.equal(r.state === 'complete' && r.content, 'abc');
});

test('private layout: 0700 directories, 0600 files, none of them symlinks', () => {
  const dir = fresh();
  const s = openChunks(dir);
  s.put(key(), 0, false, 'x');
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  const all = walk(dir);
  assert.ok(all.length >= 3);
  for (const p of all) {
    const st = lstatSync(p);
    assert.ok(!st.isSymbolicLink(), p);
    assert.equal(st.mode & 0o777, st.isDirectory() ? 0o700 : 0o600, p);
  }
});

test('the chunk root may not be a symlink', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xc-')));
  symlinkSync(tmpdir(), join(base, 'content-chunks'));
  assert.throws(() => openChunks(join(base, 'content-chunks')));
});

test('remove frees the bytes; items and registrations are separate', () => {
  const s = openChunks(fresh());
  s.put(key(), 0, false, 'aaaa');
  s.put(key({ item: 'item-2' }), 0, false, 'bb');
  s.put(key({ registration: '00000000-0000-4000-8000-0000000c0002' }), 0, false, 'c');
  const before = s.pending(REG);
  assert.ok(before > 0);
  s.remove(key());
  assert.ok(s.pending(REG) < before);
  assert.ok(s.pending('00000000-0000-4000-8000-0000000c0002') > 0);
  const r = s.put(key({ item: 'item-2' }), 1, true, 'B');
  assert.equal(r.state === 'complete' && r.content, 'bbB', 'the other item is untouched');
});

test('Q3-9 quota: a chunk past the per-registration cap labels the item incomplete; its chunks are held until remove()', () => {
  const s = openChunks(fresh(), { perRegistration: 4096, global: 1 << 20 });
  assert.equal(s.put(key(), 0, false, 'x'.repeat(1000)).state, 'pending');
  const r = s.put(key(), 1, false, 'y'.repeat(4000));
  assert.equal(r.state, 'incomplete');
  assert.ok(s.pending(REG) >= 1000, 'G3d-1: kept on disk until the caller commits the incomplete state (a failed commit can retry)');
  assert.equal(s.put(key(), 1, false, 'y'.repeat(4000)).state, 'incomplete', 'the retry is incomplete again');
  s.remove(key());
  assert.equal(s.pending(REG), 0, 'the removed item no longer holds quota');
  assert.equal(s.put(key({ item: 'small' }), 0, true, 'ok').state, 'complete', 'the registration can still assemble within its cap');
});

test('Q3-9 quota: the global cap applies across registrations', () => {
  const s = openChunks(fresh(), { perRegistration: 1 << 20, global: 4096 });
  assert.equal(s.put(key(), 0, false, 'x'.repeat(3000)).state, 'pending');
  assert.equal(s.put(key({ registration: '00000000-0000-4000-8000-0000000c0002' }), 0, false, 'y'.repeat(3000)).state, 'incomplete');
});

test('reopen: pending chunks survive and are counted toward the quota again', () => {
  const dir = fresh();
  const a = openChunks(dir, { perRegistration: 4096, global: 1 << 20 });
  a.put(key(), 0, false, 'x'.repeat(3000));
  const b = openChunks(dir, { perRegistration: 4096, global: 1 << 20 });
  assert.ok(b.pending(REG) >= 3000);
  assert.equal(b.put(key({ item: 'other' }), 0, false, 'y'.repeat(2000)).state, 'incomplete', 'recomputed pending bytes still count');
  const r = b.put(key(), 1, true, 'z');
  assert.equal(r.state === 'complete' && r.content, `${'x'.repeat(3000)}z`, 'chunks written before the restart complete the item');
});

test('review 872: pending items and chunk files per registration are capped (incomplete past the cap)', () => {
  const s = openChunks(fresh(), { perRegistration: 1 << 20, global: 1 << 20, items: 2, files: 3 });
  assert.equal(s.put(key({ item: 'a' }), 0, false, '1').state, 'pending');
  assert.equal(s.put(key({ item: 'b' }), 0, false, '1').state, 'pending');
  assert.equal(s.put(key({ item: 'c' }), 0, false, '1').state, 'incomplete', 'a third pending item');
  assert.equal(s.put(key({ item: 'a' }), 1, false, '2').state, 'pending');
  assert.equal(s.put(key({ item: 'b' }), 1, false, '2').state, 'incomplete', 'a fourth pending chunk file');
  s.remove(key({ item: 'b' })); // the caller frees it once the incomplete state is committed
  assert.equal(s.put(key({ item: 'a' }), 2, true, '3').state, 'complete', 'freed files and items are reusable');
});

test('review H1: a NUL inside session or item ids never merges two items', () => {
  const s = openChunks(fresh());
  assert.equal(s.put(key({ session: 'a\0b', item: 'c' }), 0, false, 'first').state, 'pending');
  const r = s.put(key({ session: 'a', item: 'b\0c' }), 0, true, 'second');
  assert.equal(r.state === 'complete' && r.content, 'second');
});

test('review M2/M4: reopen removes stray temp files and lists each pending item key for the caller', () => {
  const dir = fresh();
  const a = openChunks(dir);
  a.put(key(), 0, false, 'x');
  const itemDir = walk(dir).find((p) => lstatSync(p).isDirectory() && /[0-9a-f]{64}$/.test(p))!;
  writeFileSync(join(itemDir, '.stray.tmp'), 'partial');
  const b = openChunks(dir);
  assert.ok(!readdirSync(itemDir).some((n) => n.endsWith('.tmp')));
  assert.deepEqual(b.items(), [key()]);
  b.remove(key());
  assert.deepEqual(b.items(), []);
});

test('G3d-2: two producers of one item never share chunks', () => {
  const s = openChunks(fresh());
  assert.equal(s.put(key({ producer: 'acme-1' }), 0, false, 'Hello wor').state, 'pending');
  assert.equal(s.put(key({ producer: 'acme-2' }), 0, false, 'Hel').state, 'pending');
  const r = s.put(key({ producer: 'acme-2' }), 1, true, 'lo world');
  assert.equal(r.state === 'complete' && r.content, 'Hello world');
});

test('a chunk index past the bound is refused', () => {
  const s = openChunks(fresh());
  assert.throws(() => s.put(key(), 70_000, false, 'x'));
  assert.throws(() => s.put(key(), -1, false, 'x'));
});
