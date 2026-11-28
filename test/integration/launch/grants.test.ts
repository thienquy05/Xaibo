// XAIBO-PROD-615 (P7-T03, EC-84): a granted synthetic agent whose executable bytes are replaced is blocked before any launch;
// observe-only stays untouched: the service (status, transcripts, sessions) never imports launch grants, and a blocked
// revalidation writes nothing.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, grantLaunch, revalidate } from '../../../src/main/launch/grants.ts';

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xgrant-i-')));
after(() => rmSync(base, { recursive: true, force: true }));

test('replaced executable bytes: blocked, renewal required; the record is unchanged; the service never reads grants', async () => {
  const exe = join(base, 'agent-cli'), dataDir = join(base, 'data');
  writeFileSync(exe, '#!/bin/sh\necho one\n', { mode: 0o755 });
  await grantLaunch(dataDir, 'codex', { exe, template: ['resume', '{id}'], envKeys: [] }, 'bundled', await fingerprint(exe), 5);
  const record = join(dataDir, 'launch', 'grants.json'), before = readFileSync(record), mtime = statSync(record).mtimeMs;
  writeFileSync(exe, '#!/bin/sh\necho two\n');
  assert.deepEqual(await revalidate(dataDir, 'codex', { exe, template: ['resume', '{id}'], envKeys: [] }), { ok: false, blocked: 'renewal required', field: 'exe-hash' });
  assert.deepEqual([readFileSync(record), statSync(record).mtimeMs], [before, mtime]);
  const service = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? service(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
  const readers = service(join(import.meta.dirname, '..', '..', '..', 'src', 'service')).filter((f) => /launch\/grants|grants\.json/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(readers, [], 'observe-only paths never read launch grants');
});
