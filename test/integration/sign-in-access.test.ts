// XAIBO-PROD-572 (P6-T01a slice 3; EC-110, FR-54; design .handoff/p6-t01a-design.md "EC-110 access and canary test",
// security review 3647 M3): synthetic credential, auth and config files (mode 000) hold canary values
// in a temp profile. While statusLine intake, Codex rollout ingest and every signIn op run, file, process, network and
// environment access is traced: no canary target is touched, no credential variable read, and afterwards no canary byte
// is anywhere in the data folder (the DB, WAL and SHM included: native SQLite I/O is invisible to the trace) or in a
// sign-in row or reply. Limit: an application-level trace, not a syscall audit; the static import check proves the
// detector modules cannot reach the file system, processes, the network, the OS or a keychain at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as net from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import * as dns from 'node:dns';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { createIntake } from '../../src/service/receivers/intake.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { parsePortRequest } from '../../src/shared/ipc.ts';
import { answerSignIn, mutationGate } from '../../src/service/usage/sign-in-state.ts';
import { envelope, SESSION } from '../helpers/hook-store.ts';

const PID = '00000000-0000-4000-8000-0000000c5201';
const SID = '00000000-0000-4000-8000-0000000c5299';
const CRED = 'xcredcanary' + Math.random().toString(36).slice(2, 10);
const OUT = 'xoutcanary' + Math.random().toString(36).slice(2, 10);
const CRED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_API_KEY'];

function rollout(id: string, t: number): string {
  const iso = new Date(t).toISOString();
  const u = { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 120 };
  return [{ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd: '/tmp/xaibo-fixture/alpha', originator: 'codex-tui', cli_version: '0.160.0', source: 'cli' } },
    { timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u, last_token_usage: u, model_context_window: 200000 },
      rate_limits: { limit_id: 'codex', plan_type: 'pro', primary: { used_percent: 10, window_minutes: 300, resets_at: Math.floor(t / 1000) + 3600 } } } }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n';
}

test('EC-110: the sign-in paths touch no credential, auth, config or keychain target and leave no canary anywhere', async (t) => {
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'xsia-')));
  t.after(() => { try { chmodSync(join(T, 'home', '.claude'), 0o700); } catch { /* not created */ } rmSync(T, { recursive: true, force: true }); }); // code review M
  const home = join(T, 'home'), claude = join(home, '.claude'), codex = join(home, '.codex'), data = join(T, 'data');
  const day = join(codex, 'sessions', '2026', '01', '01');
  mkdirSync(claude, { recursive: true }); mkdirSync(day, { recursive: true }); mkdirSync(data, { recursive: true });
  const canaries = [join(claude, '.credentials.json'), join(claude, 'settings.json'), join(codex, 'auth.json'), join(codex, 'config.toml')];
  for (const f of canaries) { writeFileSync(f, JSON.stringify({ token: CRED })); chmodSync(f, 0o000); }
  chmodSync(claude, 0o000); // holds only canaries here: any access, native or captured, fails loudly
  writeFileSync(join(day, 'rollout-2026-01-01T00-00-00-' + SID + '.jsonl'), rollout(SID, Date.now() - 60_000));

  const store = await openStore({ file: join(data, 'xaibo.db'), backupDir: join(data, 'backups') });
  const db = store.db;
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', ?, 'default')").run(claude);
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, 'codex', ?, 'manual')").run(PID, codex);
  const writer = new Writer(db);
  const intake = createIntake({ db, writer });
  const deps = { db, writer, readOnly: false, profile: (id: string) => id === PID, allow: mutationGate() };

  const paths: string[] = [], blocked: string[] = [], env: string[] = [];
  const saved: [Record<string, unknown>, string, unknown][] = [];
  const asPath = (a: unknown) => (typeof a === 'string' ? a : a instanceof URL ? a.pathname : Buffer.isBuffer(a) ? a.toString() : null);
  const def = (m: unknown) => (m as { default: Record<string, unknown> }).default;
  const record = (mod: Record<string, unknown>, names: string[]) => {
    for (const n of names) {
      const f = mod[n];
      if (typeof f !== 'function') continue;
      saved.push([mod, n, f]);
      mod[n] = function (this: unknown, ...a: unknown[]) { const p = asPath(a[0]); if (p) paths.push(p); return (f as (...x: unknown[]) => unknown).apply(this, a); };
    }
  };
  const deny = (mod: Record<string, unknown>, label: string, names: string[]) => {
    for (const n of names) if (typeof mod[n] === 'function') { saved.push([mod, n, mod[n]]); mod[n] = () => { blocked.push(label + '.' + n); throw new Error('blocked'); }; }
  };
  const FS = ['readFileSync', 'readFile', 'openSync', 'open', 'statSync', 'stat', 'lstatSync', 'lstat', 'existsSync', 'readdirSync', 'readdir', 'accessSync',
    'access', 'realpathSync', 'realpath', 'createReadStream', 'watch', 'opendirSync', 'opendir', 'readlinkSync'];
  record(def(fs), FS);
  record(def(fs).promises as Record<string, unknown>, ['readFile', 'open', 'stat', 'lstat', 'readdir', 'access', 'realpath', 'opendir']);
  deny(def(cp), 'child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
  for (const [m, n] of [[net, 'net'], [http, 'http'], [https, 'https'], [dns, 'dns']] as const) deny(def(m), n, ['connect', 'createConnection', 'request', 'get', 'lookup', 'resolve']);
  syncBuiltinESMExports();
  const realEnv = process.env;
  const fake: Record<string, string> = { ...realEnv, HOME: home, ...Object.fromEntries(CRED_ENV.map((k) => [k, CRED])) } as Record<string, string>;
  let segment = '';
  const envBySegment: Record<string, string[]> = {};
  process.env = new Proxy(fake, {
    get(t, k) { if (typeof k === 'string') { env.push(k); (envBySegment[segment] ??= []).push(k); } return Reflect.get(t, k); },
    has(t, k) { if (typeof k === 'string') { env.push(k); (envBySegment[segment] ??= []).push(k); } return Reflect.has(t, k); },
    ownKeys(t) { env.push('*'); (envBySegment[segment] ??= []).push('*'); return Reflect.ownKeys(t); },
  }) as NodeJS.ProcessEnv;
  const replies: unknown[] = [];
  try {
    segment = 'intake';
    await intake.deliver(envelope({ event: 'statusline', cwd: null, payload: { session_id: SESSION, api_key: OUT, rate_limits: { five_hour: { used_percentage: 10, resets_at: 1767243600 } } } }));
    segment = 'codex';
    const a = new CodexAdapter({ db, writer, profileId: PID, root: codex, intervalMs: 60_000, accountSalt: Buffer.alloc(32, 3), // slice 4: the evaluation path runs under the trace
      signInRules: [{ id: 'syn-plan-pro', source: 'codex-rollout', version: '0.160.0', record: { type: 'event_msg', 'payload.type': 'token_count' }, field: 'payload.rate_limits.plan_type', test: { oneOf: ['pro'] }, method: 'subscription' }] });
    await a.start(); a.stop();
    segment = 'signIn';
    const R = (o: Record<string, unknown>) => parsePortRequest({ v: 1, type: 'signIn', id: 1, profileId: PID, ...o }) as Parameters<typeof answerSignIn>[1];
    let rev = 0;
    for (const o of [{ op: 'read' }, { op: 'set', method: 'api-key' }, { op: 'account-change' }, { op: 'set', method: 'unknown' }, { op: 'clear' }]) {
      const r = answerSignIn(deps, R(o.op === 'read' ? o : { ...o, expectedRevision: rev }), Date.now());
      replies.push(r);
      if (r.view) rev = r.view.revision;
    }
    replies.push(parsePortRequest({ v: 1, type: 'signIn', id: 1, profileId: PID, op: 'set', method: OUT, expectedRevision: rev }));
    replies.push(parsePortRequest({ v: 1, type: 'signIn', id: 1, profileId: PID, op: 'clear', expectedRevision: rev, [OUT]: CRED }));
  } finally {
    process.env = realEnv;
    for (const [m, n, f] of saved) m[n] = f;
    syncBuiltinESMExports();
  }

  const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);
  assert.deepEqual(paths.filter((p) => inside(p, claude) || canaries.includes(p)), [], 'no credential, auth or config target was opened, read or stat-ed');
  const codexInputs = [join(codex, 'session_index.jsonl')]; // the session-title index the adapter already ingests (named, not the whole profile)
  assert.deepEqual(paths.filter((p) => inside(p, codex) && p !== codex && !inside(p, join(codex, 'sessions')) && !inside(p, join(codex, 'archived_sessions')) && !codexInputs.includes(p)), [],
    'inside the Codex profile only its session folders and named inputs');
  assert.deepEqual(blocked, [], 'no process, network or DNS call');
  assert.deepEqual(env.filter((k) => CRED_ENV.includes(k)), [], 'no credential environment variable read');
  assert.deepEqual(envBySegment['signIn'] ?? [], [], 'the sign-in ops read no environment at all');
  assert.equal(replies[replies.length - 2], null, 'a canary method is refused');
  assert.equal(replies[replies.length - 1], null, 'a canary key is refused');
  const text = JSON.stringify(replies) + JSON.stringify(db.prepare('SELECT * FROM profile_sign_in').all()) + JSON.stringify(db.prepare('SELECT * FROM sign_in_boundaries').all());
  assert.ok(!text.includes(CRED) && !text.includes(OUT), 'no canary in sign-in rows, boundaries or replies');
  db.close();
  const files = readdirSync(data, { recursive: true }).map(String).map((f) => join(data, f)).filter((f) => fs.statSync(f).isFile());
  assert.ok(files.some((f) => f.endsWith('xaibo.db')));
  for (const f of files) assert.ok(!readFileSync(f).includes(CRED), 'no credential canary byte in ' + f.slice(data.length));
});

test('EC-110 static check: the sign-in detector modules import no file, process, network, OS, electron or keychain module', () => {
  const FORBIDDEN = /^(node:)?(fs|fs\/promises|child_process|net|os|http|https|dns|tls|worker_threads|vm)$|^electron$|keychain|keytar/i;
  for (const f of ['src/service/usage/sign-in.ts', 'src/service/usage/sign-in-state.ts']) {
    const src = readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
    const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    assert.deepEqual(specs.filter((s) => FORBIDDEN.test(s)), [], f);
    assert.ok(!/process\.env|require\(/.test(src), f + ' reads no environment and loads nothing dynamically');
    // code review: the store and shared modules reach fs at runtime; from here they may only be imported for types
    for (const line of src.split('\n').filter((l) => /^import .*from '(\.\.\/store\/|\.\.\/\.\.\/shared\/)/.test(l))) assert.match(line, /^import type /, f + ': ' + line);
  }
});
