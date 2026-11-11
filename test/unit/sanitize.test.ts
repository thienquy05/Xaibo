// XAIBO-PROD-101 (P1-T03): sanitize() masks every canary class, is idempotent, maps home to ~.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { PATTERNS } from '../../src/shared/secret-patterns.ts';
import { sanitize } from '../../src/shared/sanitize.ts';
import { canaries } from '../helpers/canary.ts';

test('the canary generator covers every secret pattern', () => {
  const ids = PATTERNS.map(([id]) => id).filter((id) => id.startsWith('secret-'));
  assert.ok(ids.length >= 10);
  for (const id of ids) assert.ok(id in canaries(), `no canary for ${id}`);
});

for (const [id, value] of Object.entries(canaries())) {
  test(`masks ${id}`, () => {
    const out = sanitize(`before ${value} after`);
    assert.ok(!out.includes(value), out);
    assert.match(out, /^before .* after$/);
  });
}

test('home dir becomes ~, other users\' home dirs too, plain and JSON-escaped', () => {
  assert.equal(sanitize(`${homedir()}/proj/a.ts`), '~/proj/a.ts');
  assert.equal(sanitize(homedir()), '~');
  const other = ['', 'home', 'someone', 'x'].join('/');
  assert.equal(sanitize(`cwd ${other}`), 'cwd ~/x');
  const win = ['C:', 'Users', 'someone', 'x'].join('\\');
  assert.equal(sanitize(win), '~\\x');
  assert.equal(sanitize(JSON.stringify(win)), JSON.stringify('~\\x'));
  assert.equal(sanitize('/tmp/xaibo-fixture/p ~/q relative/home/x'), '/tmp/xaibo-fixture/p ~/q relative/home/x');
});

test('configured secret keys are masked in JSON and env-like text; token counts are not', () => {
  const v = canaries()['secret-generic'].slice(3, 20);
  const json = sanitize(JSON.stringify({ ANTHROPIC_API_KEY: v, password: v, nested: { access_token: v }, max_tokens: 100, input_tokens: 5 }));
  assert.ok(!json.includes(v), json);
  assert.deepEqual(JSON.parse(json).max_tokens, 100);
  assert.deepEqual(JSON.parse(json).input_tokens, 5);
  const env = sanitize(`GITHUB_TOKEN=${v}\nclient_secret: ${v}\nPATH=/usr/bin`);
  assert.ok(!env.includes(v), env);
  assert.match(env, /PATH=\/usr\/bin$/);
});

test('idempotent on mixed text', () => {
  const c = canaries();
  const text = `${Object.values(c).join(' | ')}\n${JSON.stringify({ token: 'abcdefgh' })}\nsecret=xyz`;
  const once = sanitize(text);
  assert.equal(sanitize(once), once);
});

test('plain text and example emails are left alone', () => {
  const s = 'Session 00000000-0000-4000-8000-000000000001 ended: 3 events, owner@example.com';
  assert.equal(sanitize(s), s);
});
