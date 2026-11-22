// XAIBO-PROD-513 (P5-T05; EC-103, FR-52): settlement survives a killed expiry run. A child process expires a seeded
// multi-month history in batches (settle + delete in one transaction) and is SIGKILLed inside a transaction or between
// batches; after restart the rest is expired and the frozen totals equal those of a never-killed run, and of the live
// view before any expiry. Replay or Re-import of the expired records afterwards adds 0.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { liveMonthly } from '../../src/service/usage/monthly.ts';
import { settle } from '../../src/service/usage/settle.ts';
import { dump, expireBatch, monthlyStore, seedHistory, SECRET, tx } from '../helpers/monthly.ts';

const CHILD = new URL('../helpers/settle-child.ts', import.meta.url).pathname;
const expireAll = (db: DatabaseSync) => { while (expireBatch(db, SECRET, 3)); };

async function oracle() {
  const db = await monthlyStore();
  seedHistory(db);
  const view = liveMonthly(db, SECRET);
  expireAll(db);
  return { view, frozen: dump(db) };
}

/** Runs the child until it announces `point`, then SIGKILLs it. */
function killAt(file: string, point: 'in-tx' | 'between'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, file, SECRET.toString('hex'), point],
      { env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH ?? '', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const guard = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`child never reached ${point}: ${out} ${err}`)); }, 30_000);
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); if (out.includes(`${point}\n`)) child.kill('SIGKILL'); });
    child.on('exit', (_code, signal) => {
      clearTimeout(guard);
      if (signal === 'SIGKILL' && out.includes(`${point}\n`)) resolve();
      else reject(new Error(`child exited without reaching ${point} (${signal}): ${out} ${err}`));
    });
  });
}

for (const point of ['in-tx', 'between'] as const) {
  test(`EC-103: SIGKILL ${point === 'in-tx' ? 'inside a batch transaction' : 'between batches'}; after restart the totals equal a never-killed run`, async () => {
    const expected = await oracle();
    const file = join(mkdtempSync(join(tmpdir(), 'xsettle-crash-')), 'xaibo.db');
    const seeded = await monthlyStore(file);
    seedHistory(seeded);
    seeded.close();
    await killAt(file, point);
    const db = await monthlyStore(file); // restart: WAL recovery; profiles exist already
    const left = (db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;
    assert.equal(left, point === 'in-tx' ? 6 : 3, 'the killed batch rolled back whole (in-tx) or stayed committed (between)');
    expireAll(db);
    assert.equal(dump(db), expected.frozen);
    assert.deepEqual(liveMonthly(db, SECRET), expected.view);
    // spool replay / Re-import of the same records after expiry adds 0
    seedHistory(db);
    assert.deepEqual(liveMonthly(db, SECRET), expected.view);
    const ids = (db.prepare('SELECT id FROM sessions').all() as { id: number }[]).map((r) => r.id);
    const quota = (db.prepare('SELECT id FROM usage_history').all() as { id: number }[]).map((r) => r.id);
    assert.equal(tx(db, () => settle(db, { sessions: ids, quota }, SECRET, 1)).added, 0);
    assert.equal(dump(db), expected.frozen);
  });
}
