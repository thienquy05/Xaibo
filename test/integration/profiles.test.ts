// XAIBO-PROD-106 (P1-T08, EC-39): profiles from the default root, login-shell env overrides and manual roots;
// session identity includes the profile, so one native session id in two profiles is two sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { addManualRoot, manualPath, manualRoots, profileRoots, setManualPath, syncProfiles } from '../../src/service/catalog/detect.ts';
import { loadCatalog } from '../../src/service/catalog/validate.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { count, FIXTURES } from '../helpers/claude-profile.ts';

const withTranscript = (root: string) => {
  const dir = join(root, 'projects', '-tmp-xaibo-fixture-project');
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIXTURES, 'usage-basic'), dir, { recursive: true, filter: (s) => !s.endsWith('expected.json') });
  return root;
};

async function setup() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xprof-')));
  const home = join(tmp, 'home');
  withTranscript(join(home, '.claude'));
  const claude2 = withTranscript(join(tmp, 'claude2'));
  const codex = join(tmp, 'codex-home');
  mkdirSync(join(codex, 'sessions'), { recursive: true });
  const store = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  return { tmp, home, claude2, codex, db: store.db };
}

test('EC-39: default root and the login-env override are two Claude profiles; the same session id is two sessions', async () => {
  const s = await setup();
  const roots = profileRoots(loadCatalog(), { CLAUDE_CONFIG_DIR: s.claude2, CODEX_HOME: s.codex }, s.home, {});
  assert.deepEqual(roots, [
    { agent: 'claude', root: join(s.home, '.claude'), origin: 'default' },
    { agent: 'claude', root: s.claude2, origin: 'env' },
    { agent: 'codex', root: s.codex, origin: 'env' }, // the absent default ~/.codex is no profile
  ]);
  const profiles = syncProfiles(s.db, roots);
  assert.deepEqual(syncProfiles(s.db, roots), profiles, 'ids are stable across rescans');
  assert.equal(new Set(profiles.map((p) => p.id)).size, 3);
  for (const p of profiles) assert.doesNotMatch(p.id, /claude|codex|home|\//, 'ids are opaque');

  const writer = new Writer(s.db);
  for (const p of profiles.filter((x) => x.agent === 'claude')) {
    const a = new ClaudeAdapter({ db: s.db, writer, profileId: p.id, root: p.root, intervalMs: 60_000 });
    await a.start();
    a.stop();
  }
  assert.equal(count(s.db, 'SELECT count(*) FROM sessions'), 2);
  assert.equal(count(s.db, 'SELECT count(DISTINCT native_session_id) FROM sessions'), 1);
  assert.equal(count(s.db, 'SELECT count(DISTINCT profile_id) FROM sessions'), 2);
});

test('an override equal to the default is one profile; manual roots are honoured and kept in kv', async () => {
  const s = await setup();
  assert.deepEqual(profileRoots(loadCatalog(), { CLAUDE_CONFIG_DIR: join(s.home, '.claude') }, s.home, {}),
    [{ agent: 'claude', root: join(s.home, '.claude'), origin: 'default' }]);
  assert.equal(addManualRoot(s.db, 'claude', s.claude2), true);
  assert.equal(addManualRoot(s.db, 'claude', join(s.tmp, 'missing')), false);
  assert.deepEqual(manualRoots(s.db, 'claude'), [s.claude2]);
  const roots = profileRoots(loadCatalog(), {}, s.home, { claude: manualRoots(s.db, 'claude') });
  assert.deepEqual(roots.map((r) => r.origin), ['default', 'manual']);
});

test('a manual executable path is validated and stored as its realpath', async () => {
  const s = await setup();
  assert.equal(await setManualPath(s.db, 'claude', join(s.tmp, 'missing')), false);
  assert.equal(manualPath(s.db, 'claude'), undefined);
  assert.equal(await setManualPath(s.db, 'claude', '/bin/sh'), true);
  assert.equal(manualPath(s.db, 'claude'), realpathSync('/bin/sh'));
});
