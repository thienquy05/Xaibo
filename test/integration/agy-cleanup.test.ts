// XAIBO-PROD-211 (P2-T11, EC-81): a conversation folder that vanished while brain/ stays readable marks the session
// native-unavailable (Xaibo's copy kept, resume disabled); a missing transcript_full.jsonl in a present folder is a
// coverage gap only; an unreadable brain/ proves nothing and marks nothing; a restored folder is available again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyAdapter } from '../../src/service/adapters/agy/index.ts';
import { loadCatalog } from '../../src/service/catalog/validate.ts';
import { resumeArgv } from '../../src/service/resume.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { count } from '../helpers/claude-profile.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'agy', '1.5.6', 'basic');
const SID = '00000000-0000-4000-8000-0000000a0001';

async function profile() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xagy-clean-')));
  const root = join(tmp, 'antigravity-cli');
  mkdirSync(root, { recursive: true });
  cpSync(FIX, root, { recursive: true, filter: (s) => !s.endsWith('expected.json') });
  const store = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'b') });
  store.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('pa', 'agy', ?, 'default')").run(root);
  const a = new AgyAdapter({ db: store.db, writer: new Writer(store.db), profileId: 'pa', root, intervalMs: 60_000 });
  await a.start();
  return { tmp, root, db: store.db, a, conv: join(root, 'brain', SID) };
}
const avail = (db: import('node:sqlite').DatabaseSync) => count(db, 'SELECT native_available FROM sessions');
const eventCount = (db: import('node:sqlite').DatabaseSync) => count(db, 'SELECT count(*) FROM events');

test('EC-81: a vanished conversation folder -> native unavailable, rows kept, resume disabled; restored -> available', async () => {
  const p = await profile();
  const n = eventCount(p.db);
  const aside = join(p.tmp, 'aside');
  renameSync(p.conv, aside);
  await p.a.wake();
  assert.equal(avail(p.db), 0);
  assert.equal(eventCount(p.db), n, "Xaibo's copy is kept");
  assert.equal(count(p.db, "SELECT count(*) FROM source_files WHERE status = 'gone'"), 1);
  const r = resumeArgv(loadCatalog().sessionKinds, { agent: 'agy', entrypoint: null, originator: null, nativeSessionId: SID, nativeAvailable: false });
  assert.ok('disabled' in r && /deleted/i.test(r.reason));
  assert.ok('argv' in resumeArgv(loadCatalog().sessionKinds, { agent: 'agy', entrypoint: null, originator: null, nativeSessionId: SID }));
  await p.a.wake();
  assert.equal(count(p.db, 'SELECT count(*) FROM quarantine'), 0, 'repeated scans add nothing');

  renameSync(aside, p.conv);
  await p.a.wake();
  assert.equal(avail(p.db), 1);
  assert.equal(eventCount(p.db), n, 'nothing duplicated');
  p.a.stop();
});

test('EC-81: transcript missing in a present folder is a gap, never deletion', async () => {
  const p = await profile();
  rmSync(join(p.conv, '.system_generated', 'logs', 'transcript_full.jsonl'));
  await p.a.wake();
  await p.a.wake();
  assert.equal(avail(p.db), 1);
  assert.equal(count(p.db, "SELECT count(*) FROM quarantine WHERE reason = 'transcript-missing'"), 1);
  assert.equal(count(p.db, 'SELECT quarantined_count FROM sessions'), 1);
  p.a.stop();
});

test('EC-81: an unreadable brain/ is uncertain visibility: nothing marked', async () => {
  const p = await profile();
  const brain = join(p.root, 'brain');
  chmodSync(brain, 0o000);
  try {
    await p.a.wake();
    assert.equal(avail(p.db), 1);
    assert.equal(count(p.db, "SELECT count(*) FROM source_files WHERE status = 'gone'"), 0);
    assert.equal(count(p.db, 'SELECT count(*) FROM quarantine'), 0);
  } finally {
    chmodSync(brain, 0o755);
    p.a.stop();
  }
});
