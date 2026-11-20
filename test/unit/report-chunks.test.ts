// XAIBO-PROD-314 (P3-T13b; PRD §5.10, FR-08, EC-82, Q3-9): disk-backed content.upsert assembly. Chunks are private files
// (0700 dirs, 0600 files) under content-chunks/; an item is complete only when every chunk up to the final one is on disk;
// duplicates are idempotent; out-of-order arrival completes once; a quota hit labels the item incomplete and frees its
// bytes; pending bytes are recomputed from disk when the store reopens.
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openChunks, type ChunkKey } from '../../src/service/adapters/generic/chunks.ts';
import * as chunks from '../../src/service/adapters/generic/chunks.ts';
import { addRegistration } from '../../src/service/receivers/registrations.ts';
import * as registry from '../../src/service/receivers/registrations.ts';

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
  // quota probes (each chunk file costs its bytes + 512): 2012 + 514 held of 4096, so a 2012 chunk only fits after remove
  const OTHER = '00000000-0000-4000-8000-0000000c0002';
  const s = openChunks(fresh(), { perRegistration: 4096, global: 1 << 20 });
  s.put(key(), 0, false, 'a'.repeat(1500));
  s.put(key({ item: 'item-2' }), 0, false, 'bb');
  s.put(key({ registration: OTHER }), 0, false, 'c'.repeat(2500));
  assert.equal(s.put(key({ item: 'probe-1' }), 0, false, 'p'.repeat(1500)).state, 'incomplete', 'held before remove');
  s.remove(key());
  assert.equal(s.put(key({ item: 'probe-2' }), 0, false, 'p'.repeat(1500)).state, 'pending', 'remove freed the bytes');
  assert.equal(s.put(key({ registration: OTHER, item: 'probe' }), 0, false, 'q'.repeat(1000)).state, 'incomplete', 'the other registration still holds its bytes');
  const r = s.put(key({ item: 'item-2' }), 1, true, 'B');
  assert.equal(r.state === 'complete' && r.content, 'bbB', 'the other item is untouched');
});

test('Q3-9 quota: a chunk past the per-registration cap labels the item incomplete; its chunks are held until remove()', () => {
  const s = openChunks(fresh(), { perRegistration: 4096, global: 1 << 20 });
  assert.equal(s.put(key(), 0, false, 'x'.repeat(1000)).state, 'pending');
  const r = s.put(key(), 1, false, 'y'.repeat(4000));
  assert.equal(r.state, 'incomplete');
  assert.equal(s.put(key({ item: 'probe-1' }), 0, false, 'z'.repeat(2700)).state, 'incomplete', 'G3d-1: the 1000 bytes stay held until the caller commits the incomplete state (a failed commit can retry)');
  assert.equal(s.put(key(), 1, false, 'y'.repeat(4000)).state, 'incomplete', 'the retry is incomplete again');
  s.remove(key());
  assert.equal(s.put(key({ item: 'probe-2' }), 0, false, 'z'.repeat(2700)).state, 'pending', 'the removed item no longer holds quota');
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

// Gate 5 U1 G5a-4 (XAIBO-PROD-542): the age reaper owed since Phase 3
test('G5a-4: the reaper frees items of unregistered registrations and abandoned pending items through the live store', () => {
  const root = fresh();
  const dataDir = dirname(root);
  const live = addRegistration(dataDir, { agent: 'claude', profileKey: 'p1' }).registration.id;
  const gone = '00000000-0000-4000-8000-0000000c0009'; // revoked: no longer in the registry
  const s = openChunks(root, { perRegistration: 1 << 20, global: 1 << 20, items: 2 });
  s.put(key({ registration: live, item: 'fresh' }), 0, false, 'a');
  s.put(key({ registration: live, item: 'stale' }), 0, false, 'b');
  s.put(key({ registration: gone, item: 'orphan' }), 0, false, 'c');
  assert.equal(typeof chunks.CHUNK_ABANDON_MS, 'number', 'CHUNK_ABANDON_MS exported');
  const k = key({ registration: live, item: 'stale' });
  const stale = join(root, live, createHash('sha256').update(JSON.stringify([k.registration, k.producer, k.session, k.item, k.revision])).digest('hex'));
  const old = new Date(Date.now() - chunks.CHUNK_ABANDON_MS - 60_000);
  for (const f of readdirSync(stale)) utimesSync(join(stale, f), old, old); // its newest chunk is older than the abandon age
  assert.equal(s.put(key({ registration: live, item: 'third' }), 0, false, 'd').state, 'incomplete', 'fixture: the item cap is reached');
  const reap = (s as unknown as { reap(now: number, registered: () => Set<string> | null): number }).reap;
  assert.equal(typeof reap, 'function', 'ChunkStore.reap');
  assert.equal(reap.call(s, Date.now(), () => null), 0, 'an unreadable registry reaps nothing');
  assert.equal(s.items().length, 3);
  assert.equal(reap.call(s, Date.now(), () => new Set([live])), 2, 'the orphan and the abandoned item');
  assert.deepEqual(s.items().map((k) => k.item), ['fresh']);
  assert.equal(s.put(key({ registration: live, item: 'third' }), 0, false, 'd').state, 'pending', 'their quota is freed in the live store');
  assert.ok(!existsSync(stale), 'removed from disk');
});

test('G5a-4: the registry read tells an unreadable file (null) from an absent one (none registered)', () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'xc-')));
  assert.equal(typeof registry.readRegistrations, 'function', 'readRegistrations exported');
  assert.deepEqual(registry.readRegistrations(dataDir), [], 'absent');
  const id = addRegistration(dataDir, { agent: 'claude', profileKey: 'p1' }).registration.id;
  assert.deepEqual(registry.readRegistrations(dataDir)?.map((r) => r.id), [id]);
  writeFileSync(join(dataDir, 'registrations.json'), 'not json', { mode: 0o600 });
  assert.equal(registry.readRegistrations(dataDir), null, 'unreadable: never treated as none registered');
});

test('G5a-4 (review M): an item whose dir cannot be read now is kept this run, not taken for abandoned', () => {
  const root = fresh();
  const reg = '00000000-0000-4000-8000-0000000c000a';
  const s = openChunks(root);
  const k = key({ registration: reg, item: 'busy' });
  s.put(k, 0, false, 'live');
  const dir = join(root, reg, createHash('sha256').update(JSON.stringify([k.registration, k.producer, k.session, k.item, k.revision])).digest('hex'));
  chmodSync(dir, 0);
  try { assert.equal(s.reap(Date.now(), () => new Set([reg])), 0, 'EACCES is not age'); }
  finally { chmodSync(dir, 0o700); }
  assert.deepEqual(s.items().map((x) => x.item), ['busy']);
  assert.ok(existsSync(join(dir, '0.c')));
});
