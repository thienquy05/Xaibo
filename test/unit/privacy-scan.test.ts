import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const SCAN = join(import.meta.dirname, '..', '..', 'scripts', 'privacy-scan.ts');
const dir = mkdtempSync(join(tmpdir(), 'pscan-'));
let n = 0;
function scanText(text: string) {
  const f = join(dir, `f${n++}.txt`);
  writeFileSync(f, text);
  return spawnSync(process.execPath, [SCAN, f], { encoding: 'utf8' });
}
const scanStdin = (text: string) => spawnSync(process.execPath, [SCAN, '--stdin'], { input: text, encoding: 'utf8' });
const rnd = (len: number, alphabet: string) => Array.from(randomBytes(len), (b) => alphabet[b % alphabet.length]).join('');
const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', az = 'abcdefghijklmnopqrstuvwxyz', D = '0123456789';
const mixed = (len: number) => `Ab1${rnd(len - 3, AZ + az + D)}`;

const CANARIES: Record<string, string> = {
  home: `${homedir()}/project/file.txt`,
  uuid: randomUUID(),
  email: `someone@${rnd(8, az)}.com`,
  loopback: `http://127.0.0.1:${4000 + (randomBytes(1)[0] % 999)}/x`,
  hex32: rnd(40, 'abcdef0123456789'),
  base64url: mixed(40),
  'sk-generic': `sk-${mixed(32)}`,
  anthropic: `sk-ant-api03-${mixed(40)}`,
  aws: `AKIA${rnd(16, AZ + D)}`,
  github: `ghp_${mixed(36)}`,
  google: `AIza${mixed(35)}`,
  slack: `xoxb-${rnd(12, D)}-${rnd(12, D)}-${mixed(24)}`,
  jwt: `eyJ${mixed(20)}.eyJ${mixed(20)}.${mixed(20)}`,
  bearer: `Authorization: Bearer ${mixed(30)}`,
  pem: ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
  userinfo: `https://user:${rnd(10, az)}@example.org/`,
};

for (const [id, text] of Object.entries(CANARIES)) {
  test(`flags ${id}`, () => {
    const r = scanText(`clean line\nvalue ${text}\n`);
    assert.equal(r.status, 1, `${id} not flagged`);
    assert.match(r.stdout, /f\d+\.txt:2 /);
    assert.ok(!r.stdout.includes(text), 'match must be masked');
  });
}

test('identifiers, synthetic UUIDs, example emails, git SHAs and clean text pass', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const ok = [
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC XAIBO_DATA_DIR GEMINI_FORCE_FILE_STORAGE',
    'someVeryLongCamelCaseIdentifierWithoutDigitsAtAll anotherVeryLongCamelCaseIdentifierHere',
    'modelUsage.cacheCreationEphemeral5mInputTokens and cacheCreationEphemeral1hInputTokens',
    '00000000-0000-4000-8000-000000000001 /tmp/xaibo-fixture/project ~/project',
    'relative paths like prof/home/.claude and a/private/b are not absolute',
    'owner@example.com test@example.invalid',
    `commit ${head}`,
  ].join('\n');
  const r = scanText(ok);
  assert.equal(r.status, 0, r.stdout);
});

test('package-lock integrity lines pass (plain and diff), a secret on such a line does not', () => {
  const integ = `"integrity": "sha512-${createHash('sha512').update(randomBytes(32)).digest('base64')}",`;
  assert.equal(scanText(`    ${integ}\n`).status, 0);
  assert.equal(scanStdin(`+    ${integ}\n-    ${integ}\n`).status, 0);
  assert.equal(scanText(`    ${integ} sk-${mixed(32)}\n`).status, 1);
});

test('allow comment suppresses a documented pattern line only', () => {
  assert.equal(scanText(`patterns: /Users/ <!-- privacy-scan:allow pattern documentation -->\n`).status, 0);
  assert.equal(scanText(`patterns: ${homedir()}/x\nnext ${homedir()}/y privacy-scan:allow docs\n`).status, 1);
});

test('diff headers naming synthetic fixture files pass; other headers and fixture content are still scanned', () => {
  const f = 'test/fixtures/synthetic/codex/0.160.0/canary/rollout-2026-01-01T00-00-00-00000000-0000-4000-8000-0000000c000c.jsonl'; // privacy-scan:allow synthetic fixture name
  const ok = scanStdin(`diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n+{"type":"session_meta"}\n`);
  assert.equal(ok.status, 0, ok.stdout);
  const other = scanStdin(`+++ b/spikes/x/${mixed(40)}.json\n`);
  assert.equal(other.status, 1);
  const content = scanStdin(`+++ b/${f}\n+{"token":"${mixed(40)}"}\n`);
  assert.equal(content.status, 1);
});

test('Windows home paths are flagged plain and JSON-escaped', () => {
  assert.equal(scanStdin('path C:\\Users\\someone\\x\n').status, 1); // privacy-scan:allow synthetic test input
  assert.equal(scanStdin(JSON.stringify({ p: 'C:\\Users\\someone\\x' }) + '\n').status, 1); // privacy-scan:allow synthetic test input
});
