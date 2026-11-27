// XAIBO-PROD-568 (P6-T11; PRD SEC1, design §6.6; review R1/R2): Reveal override file. Main fixes the path, only our window's
// main frame may ask, and Finder only selects (showItemInFolder): never opens, runs or follows a link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromOurWindow, revealOverride } from '../../src/main/reveal.ts';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'xreveal-'));
  const shown: string[] = [];
  return { dataDir, file: join(dataDir, 'models.override.json'), shown, show: (p: string) => { shown.push(p); } };
}

test('a regular override file is selected in Finder', () => {
  const s = setup();
  writeFileSync(s.file, '{}');
  assert.equal(revealOverride(s.dataDir, s.show), 'file');
  assert.deepEqual(s.shown, [s.file]);
});

test('no override file: the data folder is selected instead', () => {
  const s = setup();
  assert.equal(revealOverride(s.dataDir, s.show), 'missing');
  assert.deepEqual(s.shown, [s.dataDir]);
});

test('a symlink, FIFO or directory at the override path is never followed: the folder is selected', () => {
  for (const make of [
    (s: ReturnType<typeof setup>) => { writeFileSync(join(s.dataDir, 'target'), '{}'); symlinkSync(join(s.dataDir, 'target'), s.file); },
    (s: ReturnType<typeof setup>) => execFileSync('mkfifo', [s.file]),
    (s: ReturnType<typeof setup>) => mkdirSync(s.file),
  ]) {
    const s = setup();
    make(s);
    assert.equal(revealOverride(s.dataDir, s.show), 'folder');
    assert.deepEqual(s.shown, [s.dataDir], 'never the link target');
  }
});

test('a data dir that is not a directory: nothing is shown', () => {
  const s = setup();
  const notDir = join(s.dataDir, 'plain');
  writeFileSync(notDir, 'x');
  assert.equal(revealOverride(notDir, s.show), 'failed');
  assert.equal(revealOverride(join(s.dataDir, 'missing-dir'), s.show), 'failed');
  assert.deepEqual(s.shown, []);
});

test('only our window main frame may ask (review R1)', () => {
  const mainFrame = {}, webContents = { mainFrame };
  const win = { webContents };
  assert.equal(fromOurWindow({ sender: webContents, senderFrame: mainFrame }, win), true);
  assert.equal(fromOurWindow({ sender: webContents, senderFrame: {} }, win), false, 'a subframe');
  assert.equal(fromOurWindow({ sender: {}, senderFrame: mainFrame }, win), false, 'another webContents');
  assert.equal(fromOurWindow({ sender: webContents, senderFrame: null }, win), false);
  assert.equal(fromOurWindow({ sender: webContents, senderFrame: mainFrame }, null), false, 'no window');
});
