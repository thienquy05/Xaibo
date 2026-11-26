// XAIBO-PROD-596 (P6-T08a slice A; D-P6-20 decision 2, security review H1): XAIBO_TEST_ALLOWED_ROOT gives the packaged app's
// E2E one disposable allowed root, honoured only when HOME is an isolated home apart from the account home, the root is a real
// folder strictly inside it and the data dir is outside the account home; anything else is ignored (production: nothing).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedRootsFromEnv } from '../../src/service/boot.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function world() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xallowed-')));
  dirs.push(tmp);
  const home = join(tmp, 'home'), account = join(tmp, 'account'), dataDir = join(tmp, 'data'), root = join(home, 'disposable');
  for (const d of [home, account, dataDir, root]) mkdirSync(d);
  return { tmp, home, account, dataDir, root };
}
const ENV = (v: string) => ({ XAIBO_TEST_ALLOWED_ROOT: v });

test('honoured only for a real folder strictly inside an isolated HOME, with the data dir outside the account home', () => {
  const w = world();
  const at = (o: Partial<typeof w> = {}, env: Record<string, string | undefined> = ENV(w.root)) =>
    allowedRootsFromEnv(env, { home: o.home ?? w.home, accountHome: o.account ?? w.account, dataDir: o.dataDir ?? w.dataDir });
  assert.deepEqual(at(), [w.root]);
  assert.deepEqual(at({}, {}), [], 'unset');
  assert.deepEqual(at({}, ENV('')), [], 'empty');
  assert.deepEqual(at({ account: w.home }), [], 'HOME is the account home (production)');
  assert.deepEqual(at({ account: w.tmp }), [], 'HOME inside the account home');
  mkdirSync(join(w.home, 'acct'));
  assert.deepEqual(at({ account: join(w.home, 'acct') }), [], 'the account home inside HOME');
  assert.deepEqual(at({ home: '/' }), [], 'HOME is /');
  assert.deepEqual(at({}, ENV(w.home)), [], 'the root is HOME itself');
  assert.deepEqual(at({}, ENV(w.tmp)), [], 'the root contains HOME');
  assert.deepEqual(at({}, ENV(join(w.tmp, 'data'))), [], 'outside HOME');
  assert.deepEqual(at({}, ENV('home/disposable')), [], 'relative');
  assert.deepEqual(at({}, ENV(join(w.home, 'missing'))), [], 'missing');
  symlinkSync(w.root, join(w.home, 'link'));
  assert.deepEqual(at({}, ENV(join(w.home, 'link'))), [], 'a link');
  assert.deepEqual(at({ dataDir: join(w.account) }), [], 'data dir is the account home');
  mkdirSync(join(w.account, 'data'));
  assert.deepEqual(at({ dataDir: join(w.account, 'data') }), [], 'data dir inside the account home');
  assert.deepEqual(at({ account: join(w.tmp, 'no-such-account') }), [], 'unreadable account home fails closed');
});
