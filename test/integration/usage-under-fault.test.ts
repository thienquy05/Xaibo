// XAIBO-PROD-429 (P4-T12a; PRD EC-100, FR-44): usage, context and cost work never stalls live dispatch, and the running
// service never runs a prohibited command or opens a non-loopback connection. (1) An owner override that makes 100,000
// usage rows priceable is repriced while a 5 ms timer stands in for the service loop: its lateness stays bounded and
// every row ends priced exactly once. (2) A runtime audit: recorder stubs for every agent binary and the login shell,
// and in-process recorders of every socket connect and fetch, while Claude usage, Codex token_count with rate limits and
// a price reload run; negative controls prove each recorder catches what it must.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../../src/service/boot.ts';
import { loadCatalog, type Catalog } from '../../src/service/catalog/validate.ts';
import { run } from '../../src/service/spawn.ts';

const catalog: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'synthetic');
// M1's 250 ms hook-to-paint budget: slices take ~20 ms alone; a parallel suite or GC can stretch one, while a single pass
// held the loop 1,674 ms (review M: 100 ms flaked under load)
const LAG_BOUND_MS = 250;
// x 2 fixture usage rows = 100,000 rows: a store of a few thousand sessions; repriced in one pass it held the loop ~1 s
// (measured ~10 us/row on Apple Silicon), so the regression shows on any machine.
const COPIES = 50_000;
const fallback = JSON.stringify({
  schemaVersion: 1, revision: 'owner-fallback', currency: 'USD', prices_as_of: '2026-11-12', sources: [{ id: 'owner', url: 'https://example.com/prices', retrieved: '2026-11-12' }],
  models: [], fallbacks: [{ models: ['synthetic-unlisted-model'], agent: 'claude', qualifiers: { service_tier: ['standard'], speed: ['standard'] },
    rates: { input: 1, output: 1, cache_read: 1, cache_write: { '5m': 1, '1h': 1 } } }],
});

function home(prefix: string) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const h = join(tmp, 'home');
  const project = join(h, '.claude', 'projects', '-tmp-xaibo-fixture-project');
  mkdirSync(project, { recursive: true });
  const usage = join(FIXTURES, 'claude', '2.1.319', 'usage-basic');
  for (const f of readdirSync(usage).filter((n) => n.endsWith('.jsonl'))) {
    writeFileSync(join(project, f), readFileSync(join(usage, f), 'utf8').replaceAll('"model":"claude-opus-5-5"', '"model":"synthetic-unlisted-model"'));
  }
  return { tmp, home: h, dataDir: join(tmp, 'data') };
}

test('EC-100: repricing 100,000 usage rows never holds the service loop past the bound; every row ends priced once', async () => {
  const t = home('xusage-fault-');
  // XAIBO-PROD-445 (G4a-3): a sliced job ends with one onPriced, after its last row is priced (the service resyncs then)
  const onPriced: number[] = [];
  let priced = () => -1;
  const svc = await boot({ dataDir: t.dataDir, home: t.home, catalog, intervalMs: 60_000, onPriced: () => onPriced.push(priced()) });
  const lates: number[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    await svc.done;
    const db = svc.store.db;
    db.prepare(`INSERT INTO usage (session_id, schema_version, source, identity, scope, segment, event_id, model_id, uncached_input, cache_read, cache_write,
        cache_write_classes, output, raw, completeness, source_ts)
      SELECT u.session_id, u.schema_version, u.source, u.identity || ':copy' || n.value, u.scope, u.segment, NULL, u.model_id, u.uncached_input, u.cache_read,
        u.cache_write, u.cache_write_classes, u.output, u.raw, u.completeness, u.source_ts
      FROM usage u, json_each(?) n WHERE u.scope = 'message'`).run(JSON.stringify(Array.from({ length: COPIES }, (_, i) => i)));
    const total = Number((db.prepare("SELECT count(*) AS n FROM usage WHERE scope = 'message'").get() as { n: number }).n);
    assert.equal(total, 2 + 2 * COPIES);
    writeFileSync(join(t.dataDir, 'models.override.json'), fallback);
    let expect = performance.now() + 5;
    timer = setInterval(() => { const now = performance.now(); lates.push(now - expect); expect = now + 5; }, 5);
    svc.reloadPrices();
    assert.deepEqual(onPriced, [], 'single-slice jobs (the backfill) end without one');
    priced = () => Number((db.prepare('SELECT count(*) AS n FROM cost_estimates WHERE amount_usd IS NOT NULL').get() as { n: number }).n);
    for (const end = Date.now() + 60_000; priced() < total && Date.now() < end;) await new Promise((r) => setTimeout(r, 100)); // the count itself costs loop time: poll seldom
    // a blocked loop only shows in a tick that runs after it: keep sampling a little past the end of the reprice
    const seen = lates.length;
    for (const end = Date.now() + 5000; lates.length < seen + 3 && Date.now() < end;) await new Promise((r) => setTimeout(r, 5));
    clearInterval(timer);
    assert.ok(lates.length >= 3, 'the timer sampled the loop');
    const counts = db.prepare('SELECT count(*) AS rows, count(DISTINCT session_id || covered_scope) AS scopes, count(amount_usd) AS priced FROM cost_estimates').get() as Record<string, number>;
    assert.deepEqual({ ...counts }, { rows: total, scopes: total, priced: total }, 'every row priced exactly once');
    assert.deepEqual(onPriced, [total], 'one onPriced, once every row is priced');
    const worst = Math.max(0, ...lates);
    assert.ok(worst < LAG_BOUND_MS, `the loop was held ${Math.round(worst)} ms during the reprice`);
  } finally { clearInterval(timer); svc.stop(); }
});

// XAIBO-PROD-455 (G4a-3 follow-up): an explicit price reload ends with one onPriced even when it fits one slice, so a
// mounted view refetches its cost; boot's own first price load stays silent.
test('XAIBO-PROD-455: a small override reload fires onPriced once; boot does not', async () => {
  const t = home('xusage-small-');
  let onPriced = 0;
  const svc = await boot({ dataDir: t.dataDir, home: t.home, catalog, intervalMs: 60_000, onPriced: () => { onPriced++; } });
  try {
    await svc.done;
    assert.equal(onPriced, 0, 'boot prices without a notification');
    writeFileSync(join(t.dataDir, 'models.override.json'), fallback);
    svc.reloadPrices();
    assert.equal(onPriced, 1);
    const n = Number((svc.store.db.prepare('SELECT count(*) AS n FROM cost_estimates WHERE amount_usd IS NOT NULL').get() as { n: number }).n);
    assert.ok(n > 0, 'the override priced the rows before the notification');
  } finally { svc.stop(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Runtime audit (FR-44): what the running service executes and connects to.
const PROHIBITED: [string, RegExp][] = [
  ['claude -p', /\bclaude\S*\s+(?:.*\s)?-p\b/], ['codex exec', /\bcodex\S*\s+exec\b/], ['/context', /(^|\s)\/context\b/], ['count_tokens', /count_tokens/],
];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function audit() {
  const attempts: string[] = [];
  const connect = net.Socket.prototype.connect;
  // Every Node TCP or HTTP client path ends in Socket#connect; a path option (a Unix socket) is local by definition.
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const o = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { host?: string; path?: string } | number | string;
    const host = typeof o === 'object' && o !== null ? (o.path ? null : o.host ?? 'localhost') : typeof o === 'number' ? (typeof args[1] === 'string' ? args[1] : 'localhost') : null;
    if (host !== null && !LOOPBACK.has(host)) attempts.push(host);
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;
  const fetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname;
    if (!LOOPBACK.has(host)) attempts.push(host);
    return fetch(input, init);
  }) as typeof fetch;
  return { attempts, restore: () => { net.Socket.prototype.connect = connect; globalThis.fetch = fetch; } };
}
/** Recorder stubs: every agent binary and the login shell log their argv, then behave (a version line; the shell runs -c). */
function recorders(h: string, log: string) {
  const bin = join(h, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = (name: string, body: string) => { const f = join(bin, name); writeFileSync(f, `#!/bin/sh\necho "$(basename "$0") $*" >> '${log}'\n${body}\n`); chmodSync(f, 0o755); return f; };
  stub('claude', 'echo "2.1.319 (Claude Code)"');
  stub('codex', 'echo "codex-cli 0.160.0"');
  stub('agy', 'echo "1.5.6"');
  // An isolated login env: PATH holds only the stubs and system bins, so detection never finds (or runs) an agent
  // installed on the machine running the test.
  return stub('fake-shell', `while [ $# -gt 0 ]; do [ "$1" = -c ] && exec /usr/bin/env -i HOME='${h}' PATH='${bin}:/usr/bin:/bin' /bin/sh -c "$2"; shift; done`);
}
const flagged = (lines: string[]) => lines.flatMap((l) => PROHIBITED.filter(([, re]) => re.test(l)).map(([name]) => `${name}: ${l.split(' ')[0]}`));

test('FR-44 runtime audit: usage, context and cost flows run no prohibited command and connect to nothing but loopback', async () => {
  const t = home('xusage-audit-');
  const log = join(t.tmp, 'argv.log');
  writeFileSync(log, '');
  const shell = recorders(t.home, log);
  const rollouts = join(t.home, '.codex', 'sessions', '2026', '01', '01');
  mkdirSync(rollouts, { recursive: true });
  cpSync(join(FIXTURES, 'codex', '0.160.0', 'rate-limits'), rollouts, { recursive: true, filter: (s) => !s.endsWith('expected.json') });
  const a = audit();
  let svc: Awaited<ReturnType<typeof boot>> | undefined;
  try { // review L: the patched prototypes are restored even when boot throws
    svc = await boot({ dataDir: t.dataDir, home: t.home, shell, catalog, intervalMs: 60_000 });
    await svc.done;
    writeFileSync(join(t.dataDir, 'models.override.json'), fallback);
    svc.reloadPrices();
    const db = svc.store.db;
    assert.ok(Number((db.prepare("SELECT count(*) AS n FROM usage WHERE scope = 'message'").get() as { n: number }).n) > 0, 'Claude usage was ingested');
    assert.ok(Number((db.prepare('SELECT count(*) AS n FROM usage_history').get() as { n: number }).n) > 0, 'Codex rate limits were ingested');
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.some((l) => l.startsWith('fake-shell')) && lines.some((l) => l.startsWith('claude')), 'the recorders saw the login shell and a version probe');
    assert.deepEqual(flagged(lines), [], 'no prohibited command');
    assert.deepEqual(a.attempts, [], 'no non-loopback connection');
  } finally { svc?.stop(); a.restore(); }
});

test('the audit catches an injected prohibited command and a non-loopback connect (negative controls)', async () => {
  const t = home('xusage-audit-neg-');
  const log = join(t.tmp, 'argv.log');
  writeFileSync(log, '');
  recorders(t.home, log);
  await run(join(t.home, '.local', 'bin', 'claude'), ['-p', 'synthetic'], { timeoutMs: 5000, maxBytes: 1024 });
  await run(join(t.home, '.local', 'bin', 'codex'), ['exec', 'synthetic'], { timeoutMs: 5000, maxBytes: 1024 });
  assert.deepEqual(flagged(readFileSync(log, 'utf8').split('\n').filter(Boolean)), ['claude -p: claude', 'codex exec: codex']);
  // review L: the recorders wrap no-op originals here, so the controls never send a packet
  const realConnect = net.Socket.prototype.connect, realFetch = globalThis.fetch;
  net.Socket.prototype.connect = function (this: net.Socket) { return this; } as typeof realConnect;
  globalThis.fetch = (async () => new Response('')) as typeof fetch;
  const a = audit();
  try {
    new net.Socket().connect({ host: '192.0.2.1', port: 9 }); // TEST-NET-1
    new net.Socket().connect(9, '192.0.2.3');
    new net.Socket().connect({ path: '/tmp/xaibo-fixture/socket' }); // local: not an attempt
    await globalThis.fetch('http://192.0.2.2:9/');
    assert.deepEqual(a.attempts.sort(), ['192.0.2.1', '192.0.2.2', '192.0.2.3']);
  } finally { a.restore(); net.Socket.prototype.connect = realConnect; globalThis.fetch = realFetch; }
  assert.ok(existsSync(log));
});
