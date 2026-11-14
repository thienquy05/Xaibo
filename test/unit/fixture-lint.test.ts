// P1-T02: synthetic fixture lint (EC-62). Inputs are built at test time; nothing secret-shaped is committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LINT = join(import.meta.dirname, '..', '..', 'scripts', 'fixture-lint.ts');
const hex = (n: number) => randomBytes(n).toString('hex').slice(0, n);

function lint(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'flint-'));
  mkdirSync(join(dir, 'claude'));
  writeFileSync(join(dir, 'claude', 'f.jsonl'), lines.join('\n') + '\n');
  return spawnSync(process.execPath, [LINT, dir], { encoding: 'utf8', cwd: dir });
}

test('synthetic ids, allowed paths, example emails and plain text pass', () => {
  const r = lint([
    JSON.stringify({ sessionId: `00000000-0000-4000-8000-${hex(12)}`, cwd: '/tmp/xaibo-fixture/alpha' }),
    JSON.stringify({ path: '~/.claude/projects/x.jsonl', rel: '<project>/src/a.ts', root: '/tmp/xaibo-fixture' }),
    JSON.stringify({ text: 'run /compact then see https://example.org/docs/a and a/b/c', email: 'dev@example.com' }),
    '{"partial": "malformed line kept on purpose',
  ]);
  assert.equal(r.status, 0, r.stdout);
});

test('a line-1 shebang with a standard interpreter passes; a private interpreter path does not', () => {
  for (const sb of ['#!/bin/sh', '#!/usr/bin/env node']) assert.equal(lint([sb, 'exit 0']).status, 0, sb);
  const r = lint([`#!/opt/${hex(6)}/bin/sh`, 'exit 0']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /claude\/f\.jsonl:1 fixture-path$/m);
  assert.match(lint(['exit 0', '#!/bin/sh']).stdout, /claude\/f\.jsonl:2 fixture-path$/m, 'only line 1 is a shebang');
});

const bad: Array<[string, string, string]> = [
  ['non-synthetic UUID', JSON.stringify({ sessionId: randomUUID() }), 'uuid'],
  ['absolute path outside the fixture root', JSON.stringify({ cwd: `/opt/${hex(6)}/project` }), 'fixture-path'],
  ['path in free text', JSON.stringify({ text: `cd /var/${hex(6)}/x` }), 'fixture-path'],
  ['Windows drive path', JSON.stringify({ cwd: `D:\\work\\${hex(6)}` }), 'fixture-path'],
  ['file URL', JSON.stringify({ u: `file:///srv/${hex(6)}` }), 'fixture-path'],
  ['non-example email', JSON.stringify({ email: `dev@${hex(8)}.io` }), 'email'],
  ['secret shape', JSON.stringify({ k: `ghp_Ab1${hex(36)}` }), 'secret-github'],
];

for (const [name, line, id] of bad) {
  test(`flags ${name}`, () => {
    const r = lint(['{"ok": true}', line]);
    assert.equal(r.status, 1, `${name} not flagged`);
    assert.match(r.stdout, new RegExp(`claude/f\\.jsonl:2 ${id}$`, 'm'));
    assert.ok(!r.stdout.includes(line.slice(10, 30)), 'match must be masked');
  });
}

test('the committed fixtures pass', () => {
  const r = spawnSync(process.execPath, [LINT], { encoding: 'utf8', cwd: join(import.meta.dirname, '..', '..') });
  assert.equal(r.status, 0, r.stdout);
});
