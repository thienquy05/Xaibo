import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'audit-sources.ts');
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'audit');
const MAX_LINE_BYTES = 16 * 1024 * 1024; // must match the script's cap
const T = '"timestamp":"2026-01-01T00:00:00.000Z"';

// Canaries are generated per run and never committed.
const canarySeg = `canaryseg${randomBytes(6).toString('hex')}`;
const canaryId = randomUUID();
const canaryText = `canarytext${randomBytes(6).toString('hex')}`;

function buildTree() {
  const root = mkdtempSync(join(tmpdir(), 'audit-src-'));
  cpSync(FIXTURES, root, { recursive: true });
  const projects = join(root, 'claude', 'projects');
  const canaryDir = join(projects, `-tmp-xaibo-fixture-${canarySeg}`);
  mkdirSync(canaryDir);
  writeFileSync(join(canaryDir, `${canaryId}.jsonl`), `${JSON.stringify({
    type: 'user', entrypoint: 'cli', sessionId: canaryId, cwd: `/tmp/xaibo-fixture/${canarySeg}`,
    timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: canaryText },
  })}\n`);
  // Symlink leaving the root: must be skipped, its content never read.
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'leak.jsonl'), `{"type":"leak_type","content":"${canaryText}"}\n`);
  symlinkSync(join(root, 'outside', 'leak.jsonl'), join(projects, '-tmp-xaibo-fixture-alpha', 'link.jsonl'));
  // Codex: one oversize line between two records, plus a compressed rollout that is counted only.
  const day = join(root, 'codex', 'sessions', '2026', '01', '02');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-synthetic-7.jsonl'), [
    `{${T},"type":"session_meta","payload":{"id":"00000000-0000-4000-8000-000000000007","source":"vscode","originator":"codex_vscode"}}`,
    `{"type":"response_item","pad":"${'x'.repeat(MAX_LINE_BYTES)}"}`,
    `{${T},"type":"response_item","payload":{"type":"message"}}`,
    '',
  ].join('\n'));
  writeFileSync(join(day, 'rollout-synthetic-8.jsonl.zst'),
    zstdCompressSync(Buffer.from(`{${T},"type":"zst_only_type"}\n`)));
  // Gemini: an unreadable chat file is counted, never fatal.
  const unreadable = join(root, 'gemini', 'tmp', 'fixture-project', 'chats', 'session-unreadable.jsonl');
  writeFileSync(unreadable, `{"type":"unreadable_type","content":"${canaryText}"}\n`);
  chmodSync(unreadable, 0o000);
  return root;
}

const listing = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();

test('audit-sources prints aggregated counts only and never leaks canaries', () => {
  const root = buildTree();
  try {
    const before = listing(root);
    const r = spawnSync(process.execPath, [SCRIPT,
      '--claude-root', join(root, 'claude'), '--codex-root', join(root, 'codex'), '--gemini-root', join(root, 'gemini'),
    ], { encoding: 'utf8', maxBuffer: 1 << 20 });
    assert.equal(r.status, 0, r.stderr);
    for (const c of [canarySeg, canaryId, canaryText, root, '/tmp/xaibo-fixture', '00000000-0000-4000-8000', '2026-01-0']) {
      assert.ok(!r.stdout.includes(c) && !r.stderr.includes(c), 'stdout/stderr leaked a path, id, timestamp or content');
    }
    assert.deepEqual(listing(root), before, 'script must not write');
    const out = JSON.parse(r.stdout);

    assert.deepEqual(out.claude, {
      files: 4, subagentFiles: 1, zstFiles: 0, sessionsJsonFiles: 1, unreadableFiles: 0,
      kinds: { 'entrypoint:claude-vscode': 1, 'entrypoint:cli': 3 },
      recordTypes: { '<other>': 1, assistant: 3, system: 1, user: 3, xaibo_future_type: 1 },
      records: 9, unknownRecords: 2, unknownShare: 0.2222,
      lines: { partialTrailing: 1, malformed: 1, oversize: 0 },
    });
    assert.deepEqual(out.codex, {
      files: 3, archivedFiles: 1, zstFiles: 1, unreadableFiles: 0,
      kinds: {
        'originator:codex_cli_rs': 1, 'originator:codex_exec': 1, 'originator:codex_vscode': 1,
        'source:cli': 1, 'source:exec': 1, 'source:vscode': 1,
      },
      recordTypes: { compacted: 1, event_msg: 2, response_item: 2, session_meta: 3, turn_context: 1 },
      records: 9, unknownRecords: 0, unknownShare: 0,
      lines: { partialTrailing: 0, malformed: 0, oversize: 1 },
    });
    assert.deepEqual(out.gemini, {
      files: 2, legacyJsonChats: 1, zstFiles: 0, unreadableFiles: 1,
      kinds: {},
      recordTypes: { gemini: 1, user: 1 },
      records: 2, unknownRecords: 'unavailable', unknownShare: 'unavailable',
      lines: { partialTrailing: 0, malformed: 0, oversize: 0 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing roots print zero counts and exit 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-empty-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT,
      '--claude-root', join(root, 'c'), '--codex-root', join(root, 'x'), '--gemini-root', join(root, 'g'),
    ], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.claude.files, 0);
    assert.equal(out.codex.unknownShare, 'unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('id-shaped and prototype-named discriminators, off-glob files, partial overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-hostile-'));
  try {
    const letterId = `a${randomUUID().slice(1)}`; // matches the discriminator pattern, must still be <other>
    mkdirSync(join(root, 'c', 'projects', 'p'), { recursive: true });
    writeFileSync(join(root, 'c', 'projects', 'p', 's.jsonl'), [
      `{"type":"constructor","entrypoint":"${letterId}"}`, '{"type":"__proto__"}', `{"type":"${letterId}"}`, '',
    ].join('\n'));
    mkdirSync(join(root, 'c', 'sessions', 'nested'), { recursive: true });
    writeFileSync(join(root, 'c', 'sessions', 'nested', 'n.json'), '{}');
    for (const d of [join('a', 'b', 'chats'), join('p', 'chats', 'sub')]) {
      mkdirSync(join(root, 'g', 'tmp', d), { recursive: true });
      writeFileSync(join(root, 'g', 'tmp', d, 'x.jsonl'), '{"type":"off_glob"}\n');
    }
    const args = [SCRIPT, '--claude-root', join(root, 'c'), '--codex-root', join(root, 'x'), '--gemini-root', join(root, 'g')];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(letterId), 'id-shaped value printed');
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.claude.recordTypes, { '<other>': 1, ['__proto__']: 1, constructor: 1 });
    assert.deepEqual(out.claude.kinds, { 'entrypoint:<other>': 1 });
    assert.equal(out.claude.sessionsJsonFiles, 0);
    assert.equal(out.gemini.files, 0);
    // A partial override must not fall back to the default stores; the env points them at temp dirs anyway.
    const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root, GEMINI_CLI_HOME: root };
    const partial = spawnSync(process.execPath, args.slice(0, 3), { encoding: 'utf8', env });
    assert.notEqual(partial.status, 0);
    assert.equal(partial.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('default roots follow App. F and the agent home variables (pure, no filesystem access)', async () => {
  const { defaultRoots } = await import(SCRIPT);
  const home = '/tmp/xaibo-fixture/home';
  assert.deepEqual(defaultRoots({}, home), {
    claude: '/tmp/xaibo-fixture/home/.claude',
    codex: '/tmp/xaibo-fixture/home/.codex',
    gemini: '/tmp/xaibo-fixture/home/.gemini',
  });
  assert.deepEqual(defaultRoots({
    CLAUDE_CONFIG_DIR: '/tmp/xaibo-fixture/cc', CODEX_HOME: '/tmp/xaibo-fixture/cx', GEMINI_CLI_HOME: '/tmp/xaibo-fixture/gh',
  }, home), {
    claude: '/tmp/xaibo-fixture/cc',
    codex: '/tmp/xaibo-fixture/cx',
    gemini: '/tmp/xaibo-fixture/gh/.gemini',
  });
});
