// XAIBO-PROD-553 (D-P5-22 diagnostic, Codex round 3): a perf-only temp_store override. XAIBO_TEMP_STORE=file is honoured
// only under XAIBO_PERF_TRACE=1 (as XAIBO_RETENTION_DELAY_MS); the shipped default stays MEMORY.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { tempStoreFromEnv } from '../../src/service/boot.ts';
import { openStore } from '../../src/service/store/db.ts';

const tempStore = (db: DatabaseSync) => Number(Object.values(db.prepare('PRAGMA temp_store').get() ?? {})[0]);
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }); // review L1: no temp-folder leak
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'xtemp-')); dirs.push(d); return { file: join(d, 'xaibo.db'), backupDir: join(d, 'backups') }; };

test('tempStoreFromEnv: file only under the perf trace with XAIBO_TEMP_STORE=file; anything else keeps the default', () => {
  assert.equal(tempStoreFromEnv({ XAIBO_PERF_TRACE: '1', XAIBO_TEMP_STORE: 'file' }), 'file');
  for (const env of [{ XAIBO_TEMP_STORE: 'file' }, { XAIBO_PERF_TRACE: '0', XAIBO_TEMP_STORE: 'file' }, { XAIBO_PERF_TRACE: '1', XAIBO_TEMP_STORE: 'FILE' },
    { XAIBO_PERF_TRACE: '1', XAIBO_TEMP_STORE: 'memory' }, { XAIBO_PERF_TRACE: '1' }, {}]) assert.equal(tempStoreFromEnv(env), undefined, JSON.stringify(env));
});

test('openStore: temp_store MEMORY by default (2), FILE when asked (1)', async () => {
  const a = await openStore(fresh());
  assert.equal(tempStore(a.db), 2);
  a.db.close();
  const b = await openStore({ ...fresh(), tempStore: 'file' });
  assert.equal(tempStore(b.db), 1);
  b.db.close();
});
