// XAIBO-PROD-594 (P6-T08 slice E; US-8, design §6.5.2 "a reason string in the session view", D-P6-19): the open session names the
// surfaces Xaibo has not verified for the agent's detected version (VS Code extension, Desktop app), from the catalog's
// compatibility rows; bounded on the wire; no limits when none are known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerSession } from '../../src/service/api.ts';
import { openStore } from '../../src/service/store/db.ts';
import { parsePortMessage } from '../../src/shared/ipc.ts';

test('the session detail carries the unverified surface lines for its agent; the reply is bounded', async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'xsl-')));
  const { db } = await openStore({ file: join(d, 'xaibo.db'), backupDir: join(d, 'b') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', '/tmp/xaibo-fixture/sl', 'manual')").run();
  const id = Number(db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id) VALUES ('codex', 'p1', 'sl-1')").run().lastInsertRowid);
  const lines = ['VS Code extension: unverified for 0.160.0 (not tested)', 'Desktop app: unverified for 0.160.0 (not tested)'];
  const asked: string[] = [];
  const r = answerSession(db, { v: 1, type: 'session', id: 1, session: id }, [], [], undefined, undefined, (agent) => { asked.push(agent); return lines; });
  assert.deepEqual(asked, ['codex']);
  assert.deepEqual(r.detail?.limits, lines);
  assert.deepEqual((parsePortMessage(r) as typeof r).detail?.limits, lines, 'the reply passes the renderer parser');
  assert.equal(answerSession(db, { v: 1, type: 'session', id: 1, session: id }).detail?.limits, undefined, 'no resolver, no limits');
  const over = (limits: unknown) => parsePortMessage({ ...r, detail: { ...r.detail, limits } });
  assert.equal(over(Array.from({ length: 5 }, () => 'x')), null, 'at most 4 lines');
  assert.equal(over(['x'.repeat(257)]), null, 'at most 256 characters');
  db.close();
});
