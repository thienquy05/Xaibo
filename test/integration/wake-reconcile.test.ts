// XAIBO-PROD-312 (P3-T12; EC-43, FR-02, EC-19): the service's suspend marks a busy live session stale; records appended
// while suspended to a transcript that has no file watch (old mtime at start, so only the scan finds it) appear within
// interval + 1 s of the wake (here well under 1 s with a 60 s interval: the wake reconciles at once, bounded, no
// full-history scan), and the session reads connected again after them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../../src/service/boot.ts';
import { loadCatalog, type Catalog } from '../../src/service/catalog/validate.ts';
import { count, until } from '../helpers/claude-profile.ts';

const SESSION = '00000000-0000-4000-8000-0000000f1201';
const catalog: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };
const line = (o: object) => `${JSON.stringify({ parentUuid: null, isSidechain: false, cwd: '/tmp/xaibo-fixture/wake', sessionId: SESSION, version: '2.1.319',
  timestamp: new Date().toISOString(), ...o })}\n`;

test('EC-43: suspend → stale; appends while suspended are reconciled within interval + 1 s of the wake; connected after', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xwake-')));
  const home = join(tmp, 'home');
  const project = join(home, '.claude', 'projects', '-tmp-xaibo-fixture-wake');
  mkdirSync(project, { recursive: true });
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "2.1.319 (Claude Code)"\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const transcript = join(project, `${SESSION}.jsonl`);
  writeFileSync(transcript, line({ type: 'user', uuid: '00000000-0000-4000-8000-0000000f1211', message: { role: 'user', content: 'fixture prompt' } }));
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(transcript, hourAgo, hourAgo); // not recently active: no file watch, only the reconciliation scan

  const svc = await boot({ dataDir: join(tmp, 'data'), home, catalog, intervalMs: 60_000 });
  try {
    await svc.done;
    const pid = String((svc.store.db.prepare("SELECT id FROM profiles WHERE agent = 'claude'").get() as { id: string }).id);
    await until(() => svc.status('claude', SESSION, pid)?.lifecycle === 'busy', 2_000);
    assert.equal(svc.status('claude', SESSION, pid)!.health, 'connected');
    svc.suspend(Date.now());
    assert.equal(svc.status('claude', SESSION, pid)!.health, 'stale');

    const before = count(svc.store.db, 'SELECT count(*) FROM events');
    appendFileSync(transcript, line({ type: 'assistant', uuid: '00000000-0000-4000-8000-0000000f1212', message: { id: 'msg_fixture_wake', role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_fixture_wake', name: 'Bash', input: { command: 'npm run build' } }], stop_reason: 'tool_use' } }));
    await svc.wake();
    await until(() => count(svc.store.db, 'SELECT count(*) FROM events') > before, 1_000);
    await until(() => svc.status('claude', SESSION, pid)?.health === 'connected', 1_000);
    assert.deepEqual(svc.status('claude', SESSION, pid)!.findings, []);
  } finally { svc.stop(); }
});
