import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduce } from './reduce.ts';

const HERE = import.meta.dirname;
const SCAN = join(HERE, '..', '..', 'scripts', 'privacy-scan.ts');
const RECORDER = join(HERE, 'record-hook.mjs');

function rawFixture() {
  const sid = randomUUID();
  const secret = `sk-${randomBytes(24).toString('hex')}`;
  const line = {
    agent: 'claude', event: 'PreToolUse', ts_mono_ns: '1', argv_len: 2, stdin_bytes: 10,
    payload: {
      hook_event_name: 'PreToolUse', session_id: sid, cwd: `${homedir()}/work/proj`, transcript_path: `${tmpdir()}/t.jsonl`,
      tool_name: 'Bash', tool_input: { command: `echo ${secret}` }, permission_mode: 'default',
      source: 'some free text with spaces', model: 'model-1', [`${homedir()}/as-key`]: 1, [sid]: { x: 1 },
      account: { plan: 'secret-plan', email: 'person@example.net' },
    },
  };
  return { sid, secret, text: `${JSON.stringify(line)}\n` };
}

test('reducer keeps key paths, types and allowlisted enums only', () => {
  const { sid, secret, text } = rawFixture();
  const out = JSON.stringify(reduce(text.trim().split('\n').map((l) => JSON.parse(l))));
  for (const leak of [sid, secret, homedir(), tmpdir(), 'secret-plan', 'person@example.net', 'free text']) assert.ok(!out.includes(leak), `leaked ${leak}`);
  const ev = reduce([JSON.parse(text)]).PreToolUse;
  assert.equal(ev.count, 1);
  assert.deepEqual(ev.keys['tool_name'].values, ['Bash']);
  assert.deepEqual(ev.keys['permission_mode'].values, ['default']);
  assert.deepEqual(ev.keys['source'].values, ['<other>']);
  assert.deepEqual(ev.keys['session_id'].types, ['string']);
  assert.equal(ev.keys['session_id'].values, undefined);
  assert.ok(ev.keys['tool_input.command']);
  assert.ok(ev.keys['<key>'] || ev.keys['<key>.x'], 'non-identifier keys are masked');
});

test('privacy-scan flags the unscrubbed raw file; reducer CLI output passes', () => {
  const d = mkdtempSync(join(tmpdir(), 'reduce-'));
  const { text } = rawFixture();
  writeFileSync(join(d, 'raw.jsonl'), text);
  assert.equal(spawnSync(process.execPath, [SCAN, join(d, 'raw.jsonl')]).status, 1);
  const r = spawnSync(process.execPath, [join(HERE, 'reduce.ts'), '--in', join(d, 'raw.jsonl'), '--out', join(d, 'evidence'), '--schema']);
  assert.equal(r.status, 0, String(r.stderr));
  const files = readdirSync(join(d, 'evidence'));
  assert.ok(files.includes('reduced.json') && files.some((f) => f.endsWith('.schema.json')));
  assert.equal(spawnSync(process.execPath, [SCAN, join(d, 'evidence')]).status, 0);
  assert.ok(readFileSync(join(d, 'evidence', 'PreToolUse.schema.json'), 'utf8').includes('"tool_name"'));
});

test('recorder self-test: 0 bytes stdout/stderr, exit 0, one line appended', () => {
  const r = spawnSync(process.execPath, [RECORDER, '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /self-test ok/);
});

test('keys of a JSON-Schema properties map (tool parameter names) are masked', () => {
  const r = reduce([{ event: 'x', payload: { tools: [{ input_schema: { properties: { syntheticParam: { type: 'string' } } } }] } }]);
  const paths = Object.keys(r.x!.keys);
  assert.ok(paths.includes('tools[].input_schema.properties.<key>.type'));
  assert.ok(!paths.some((p) => p.includes('syntheticParam')));
});
