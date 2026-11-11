// XAIBO-PROD-106 (P1-T08, OQ-P1-03): one fixed-argv login-shell `env -0` read, stdin ignored, bounded, allowlisted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv0, readLoginEnv } from '../../src/service/catalog/env.ts';
import { createLogger } from '../../src/shared/log.ts';
import { canaries } from '../helpers/canary.ts';

const dir = mkdtempSync(join(tmpdir(), 'xenv-'));
const shell = (name: string, body: string) => {
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
};
const z = (...entries: string[]) => Buffer.from(entries.map((e) => `${e}\0`).join(''));

test('parseEnv0 keeps allowlisted keys only and survives noise around the output', () => {
  const out = Buffer.concat([Buffer.from('welcome=to the shell\nmotd line\n'), z('PATH=/tmp/xaibo-fixture/bin:/usr/bin', 'SECRET_TOKEN=x', 'CODEX_HOME=/tmp/xaibo-fixture/codex', 'CLAUDE_CONFIG_DIR='), Buffer.from('bye\n')]);
  assert.deepEqual(parseEnv0(out), { PATH: '/tmp/xaibo-fixture/bin:/usr/bin', CODEX_HOME: '/tmp/xaibo-fixture/codex' });
  assert.deepEqual(parseEnv0(Buffer.alloc(0)), {});
});

test('noisy login shell: fixed argv, stdin closed, only the four keys come back, nothing secret is logged', async () => {
  const argvFile = join(dir, 'argv');
  // Prints noise, blocks on stdin if it were open, then runs the -c command like a login shell would.
  const sh = shell('noisy', `printf '%s\\n' "$@" > '${argvFile}'\necho "Last login: noise=1"\nread ignored\nexec /bin/sh -c "$3"`);
  const canary = canaries()['secret-anthropic']!;
  const logs = join(dir, 'logs');
  const env = await readLoginEnv({
    shell: sh,
    env: { PATH: '/tmp/xaibo-fixture/bin:/usr/bin:/bin', CLAUDE_CONFIG_DIR: '/tmp/xaibo-fixture/claude2', ANTHROPIC_API_KEY: canary },
    log: createLogger({ dir: logs, secret: Buffer.alloc(32, 1) }),
  });
  assert.deepEqual(env, { PATH: '/tmp/xaibo-fixture/bin:/usr/bin:/bin', CLAUDE_CONFIG_DIR: '/tmp/xaibo-fixture/claude2' });
  assert.deepEqual(readFileSync(argvFile, 'utf8').split('\n').filter(Boolean), ['-l', '-c', '/usr/bin/env -0']);
  const logText = readFileSync(join(logs, 'xaibo.log'), 'utf8');
  assert.match(logText, /"event":"login_env"/);
  assert.ok(!logText.includes(canary) && !logText.includes('claude2'));
});

test('a hanging shell times out to an empty result', async () => {
  const t0 = Date.now();
  assert.deepEqual(await readLoginEnv({ shell: shell('hang', 'sleep 5'), timeoutMs: 300 }), {});
  assert.ok(Date.now() - t0 < 2_000);
});

test('missing, relative or failing shells give an empty result, never a throw', async () => {
  assert.deepEqual(await readLoginEnv({ shell: join(dir, 'absent') }), {});
  assert.deepEqual(await readLoginEnv({ shell: 'sh' }), {});
  assert.deepEqual(await readLoginEnv({}), {});
  assert.deepEqual(await readLoginEnv({ shell: shell('fails', 'exit 3') }), {});
});

test('output above the bound is dropped', async () => {
  const big = shell('big', 'head -c 300000 /dev/zero | tr "\\0" a; exec /bin/sh -c "$3"');
  assert.deepEqual(await readLoginEnv({ shell: big, maxBytes: 64 * 1024 }), {});
});
