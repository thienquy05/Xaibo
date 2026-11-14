// XAIBO-PROD-319 (P3-T15, PRD §9.3 account canary, §5.11, FR-44, FR-45, EC-92; egress registry 'usage-account').
// Runtime-generated account-ID, org-ID, email and credential canaries in a temp HOME (~/.claude.json, Claude and
// Codex credential files), in a Codex session_meta and token_count, and in statusLine payloads. Booting the service
// and ingesting never opens those files (fs, fs/promises and read streams spied), and no canary byte reaches the
// usage, context or cost tables, the logs or a diagnostics bundle. The Codex account marker is neither the raw id nor
// its plain SHA-256 (review M1).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs, { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { buildBundle, readLogTail } from '../../src/main/diagnostics.ts';
import { boot } from '../../src/service/boot.ts';
import { loadCatalog, type Catalog } from '../../src/service/catalog/validate.ts';
import { createLogger } from '../../src/shared/log.ts';
import { FIXTURES } from '../helpers/claude-profile.ts';
import { envelope, hookStore, SESSION } from '../helpers/hook-store.ts';

const catalog: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };
const CODEX_SESSION = '00000000-0000-4000-8000-0000000c1601';

function canaries() {
  const u = () => randomUUID().replace(/-/g, '');
  return { account: `acct-${u()}`, org: `org-${u()}`, email: `c${u().slice(0, 12)}@example.invalid`, credential: `cred-${randomBytes(24).toString('hex')}` };
}
type C = ReturnType<typeof canaries>;
const values = (c: C) => Object.values(c);

const TABLES = ['usage_scopes', 'usage_history', 'usage_snapshots', 'context_snapshots', 'cost_estimates'];
function tableHits(db: DatabaseSync, c: C): string[] {
  const hits: string[] = [];
  for (const t of TABLES) {
    const text = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());
    for (const v of values(c)) if (text.includes(v)) hits.push(`${t}: ${v.slice(0, 4)}`);
  }
  const epochs = JSON.stringify(db.prepare('SELECT account_epoch FROM sessions').all());
  for (const v of values(c)) if (epochs.includes(v)) hits.push('sessions.account_epoch');
  return hits;
}

/** Records every path opened or read through fs, fs/promises and read streams while `fn` runs. */
async function opened<T>(fn: () => Promise<T>): Promise<{ result: T; paths: string[] }> {
  const paths: string[] = [];
  const note = (p: unknown) => { if (typeof p === 'string' || Buffer.isBuffer(p) || p instanceof URL) paths.push(String(p)); };
  type Fn = (...x: unknown[]) => unknown;
  const spy = (o: object, m: string) => {
    const original = (o as Record<string, Fn>)[m]!;
    return mock.method(o as Record<string, Fn>, m, function (this: unknown, ...a: unknown[]) { note(a[0]); return original.apply(this, a); });
  };
  const spies = [
    ...['openSync', 'open', 'readFileSync', 'readFile', 'createReadStream'].map((m) => spy(fs, m)),
    ...['open', 'readFile'].map((m) => spy(fs.promises, m)),
  ];
  syncBuiltinESMExports();
  try {
    return { result: await fn(), paths };
  } finally {
    for (const s of spies) s.mock.restore();
    syncBuiltinESMExports();
  }
}

test('canary: usage-account', async () => {
  const c = canaries();
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xcan-')));
  const home = join(tmp, 'home');
  // Claude: transcript fixture, plus account and credential files that must never be opened
  const project = join(home, '.claude', 'projects', '-tmp-xaibo-fixture-project');
  mkdirSync(project, { recursive: true });
  cpSync(join(FIXTURES, 'usage-basic'), project, { recursive: true, filter: (s) => !s.endsWith('expected.json') });
  const secretFiles = [join(home, '.claude.json'), join(home, '.claude', '.credentials.json'), join(home, '.codex', 'auth.json')];
  mkdirSync(join(home, '.codex', 'sessions', '2026', '01', '01'), { recursive: true });
  for (const f of secretFiles) writeFileSync(f, JSON.stringify({ accountUuid: c.account, organizationUuid: c.org, emailAddress: c.email, token: c.credential }));
  // Codex: account id in session_meta, canaries in token_count rate_limits and credits
  const lines = [
    { timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: CODEX_SESSION, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/xaibo-fixture/alpha',
      originator: 'codex-tui', cli_version: '0.160.0', source: 'cli', creator_account_id: c.account, creator_user_id: c.org } },
    { timestamp: '2026-01-01T00:00:03.000Z', type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 } },
      rate_limits: { limit_id: 'codex', limit_owner: c.org, plan_type: c.email, account_email: c.email, credits: { has_credits: true, balance: '1', owner: c.account, token: c.credential },
        primary: { used_percent: 5, window_minutes: 300, resets_at: 1767243600, account: c.account } } } },
  ];
  writeFileSync(join(home, '.codex', 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${CODEX_SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "2.1.319 (Claude Code)"\n');
  chmodSync(join(bin, 'claude'), 0o755);

  const dataDir = join(tmp, 'data');
  const logDir = join(tmp, 'logs');
  const log = createLogger({ dir: logDir, secret: randomBytes(32) });
  const { result: svc, paths } = await opened(async () => {
    const s = await boot({ dataDir, home, catalog, intervalMs: 60_000, log });
    await s.done;
    return s;
  });
  const db = svc.store.db;
  assert.equal(Number((db.prepare('SELECT count(*) AS n FROM usage_history').get() as { n: number }).n), 1, 'the Codex reading was ingested');
  for (const f of secretFiles) assert.ok(!paths.some((p) => p === f || p.endsWith(f)), `never opened: ${f.slice(home.length)}`);
  assert.ok(paths.length > 0, 'the spy saw the ingest');

  const epoch = (db.prepare('SELECT account_epoch AS e FROM sessions WHERE native_session_id = ?').get(CODEX_SESSION) as { e: string | null }).e;
  assert.match(epoch ?? '', /^[0-9a-f]{32}$/);
  assert.ok(!createHash('sha256').update(c.account).digest('hex').startsWith(epoch!), 'not a plain hash of the id');
  assert.deepEqual(tableHits(db, c), []);

  // statusLine payloads with account-like fields beside the allowlisted ones
  const h = await hookStore();
  await h.intake.deliver(envelope({ event: 'statusline', cwd: null, payload: { session_id: SESSION, account: { uuid: c.account, org: c.org, email: c.email },
    oauth_token: c.credential, cost: { total_cost_usd: 0.1, account: c.account }, rate_limits: { five_hour: { used_percentage: 3, account: c.email }, org_id: c.org },
    context_window: { context_window_size: 200000, current_usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, email: c.email } } } }));
  assert.equal(Number((h.db.prepare('SELECT count(*) AS n FROM usage_history').get() as { n: number }).n), 1);
  assert.deepEqual(tableHits(h.db, c), []);

  svc.stop();
  const tail = readLogTail(logDir, { lines: 1000, bytes: 1 << 20 });
  const bundle = buildBundle({ app: {}, os: {}, health: { v: 1, type: 'health', state: 'running', attempt: 0, readOnly: null }, counters: {}, logTail: tail });
  for (const v of values(c)) {
    assert.ok(!tail.join('\n').includes(v), 'logs');
    assert.ok(!bundle.includes(v), 'diagnostics bundle');
  }
});
