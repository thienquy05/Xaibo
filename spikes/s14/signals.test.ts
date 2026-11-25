// P6-S14-T1 (S14, FR-54) synthetic S-tests, written before the classifier (plan §3.1). Synthetic records and provisional
// synthetic rules only: passing here certifies no live mapping. Classification runs on the production projection
// (captureRecord for the Claude statusLine, the Codex rollout parser + codexRateLimits), so a field production drops
// can never become a mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as net from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import * as dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, ruleIssues, type Observation, type Rule } from './signals.ts';
import { serialize } from './report.ts';
import { readBounded, rowsFor, under } from './collect.ts';
import { captureLine } from './capture.ts';
import { keyNames } from './report.ts';

const RULES = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'rules.synthetic.json'), 'utf8')) as Rule[];
const V = '0.0.0-synthetic';
const statusline = (o: unknown, version = V): Observation => ({ source: 'claude-statusline', version, raw: JSON.stringify(o) });
const rollout = (o: unknown, version = V): Observation => ({ source: 'codex-rollout', version, raw: JSON.stringify(o) });
const tokenCount = (rl: unknown) => ({ timestamp: '2026-01-01T00:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rl } });
const plan = (p: unknown) => rollout(tokenCount({ limit_id: 'codex', plan_type: p, primary: { used_percent: 5, window_minutes: 300, resets_at: 1767225600 }, secondary: null }));
const window5h = { rate_limits: { five_hour: { used_percentage: 12, resets_at: 1767225600 } } };

test('synthetic rules are well formed (a provisional catalog, not verified data)', () => {
  for (const r of RULES) assert.deepEqual(ruleIssues(r), [], r.id);
});

test('each method from its explicit synthetic rule: subscription, API key, cloud provider, gateway, mixed', () => {
  assert.deepEqual(classify([statusline(window5h)], RULES), { method: 'subscription', rules: ['syn-claude-five-hour'] });
  assert.deepEqual(classify([plan('synthplus')], RULES), { method: 'subscription', rules: ['syn-codex-plan-subscription'] });
  assert.deepEqual(classify([plan('synthkey')], RULES), { method: 'api-key', rules: ['syn-codex-plan-key'] });
  assert.deepEqual(classify([plan('synthcloud')], RULES), { method: 'cloud-provider', rules: ['syn-codex-plan-cloud'] });
  assert.deepEqual(classify([plan('synthgateway')], RULES), { method: 'gateway', rules: ['syn-codex-plan-gateway'] });
  assert.deepEqual(classify([plan('synthmixed')], RULES), { method: 'mixed', rules: ['syn-codex-plan-mixed'] });
});

test('repeated agreeing evidence stays one method', () => {
  assert.deepEqual(classify([plan('synthplus'), plan('synthplus')], RULES), { method: 'subscription', rules: ['syn-codex-plan-subscription'] });
});

test('absent, null, empty and malformed fields prove nothing', () => {
  const unknown = { method: 'unknown', reason: 'no-signal' };
  for (const o of [{}, { rate_limits: null }, { rate_limits: {} }, { rate_limits: { five_hour: null } }, { rate_limits: { five_hour: {} } },
    { rate_limits: { five_hour: { used_percentage: 'x' } } }, { rate_limits: { five_hour: [] } }, { rate_limits: 'five_hour' }]) {
    assert.deepEqual(classify([statusline(o)], RULES), unknown, JSON.stringify(o));
  }
  for (const p of [undefined, null, '', 7, ['synthplus'], { v: 'synthplus' }, 'synth plus', 'x'.repeat(40)]) {
    assert.deepEqual(classify([plan(p)], RULES), unknown, String(p));
  }
  assert.deepEqual(classify([{ source: 'codex-rollout', version: V, raw: '{not json' }], RULES), unknown);
  assert.deepEqual(classify([{ source: 'claude-statusline', version: V, raw: '[1]' }], RULES), unknown);
  assert.deepEqual(classify([], RULES), unknown);
});

test('an unrecognized plan enum stays Unknown; a valid-looking string is not enough', () => {
  assert.deepEqual(classify([plan('synthother')], RULES), { method: 'unknown', reason: 'no-signal' });
  assert.deepEqual(classify([plan('SYNTHPLUS')], RULES), { method: 'unknown', reason: 'no-signal' });
});

test('exact version only: no extrapolated range', () => {
  for (const v of ['0.0.1-synthetic', '0.0.0', '0.0.0-synthetic.1']) {
    assert.deepEqual(classify([statusline(window5h, v)], RULES), { method: 'unknown', reason: 'unsupported-version' }, v);
  }
});

test('wrong record type or a field only in message or tool text never matches', () => {
  const unknown = { method: 'unknown', reason: 'no-signal' };
  assert.deepEqual(classify([rollout({ type: 'response_item', payload: { type: 'token_count', rate_limits: { plan_type: 'synthplus' } } })], RULES), unknown);
  assert.deepEqual(classify([rollout({ type: 'event_msg', payload: { type: 'agent_message', rate_limits: { plan_type: 'synthplus' } } })], RULES), unknown);
  assert.deepEqual(classify([rollout({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '"plan_type":"synthplus"' }] } })], RULES), unknown);
  assert.deepEqual(classify([rollout({ type: 'response_item', payload: { type: 'function_call_output', output: 'rate_limits plan_type synthplus' } })], RULES), unknown);
  assert.deepEqual(classify([{ source: 'claude-transcript', version: V, raw: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'rate_limits five_hour subscription' }] } }) }], RULES), unknown);
});

test('a field production drops cannot become a mapping', () => {
  const dropped: Rule = { id: 'syn-claude-auth-field', source: 'claude-statusline', version: V, record: {}, field: 'auth.method', test: { oneOf: ['synthkey'] }, method: 'api-key' };
  assert.deepEqual(ruleIssues(dropped), []);
  assert.deepEqual(classify([statusline({ auth: { method: 'synthkey' } })], [dropped]), { method: 'unknown', reason: 'no-signal' });
  const droppedCodex: Rule = { id: 'syn-codex-limit-name', source: 'codex-rollout', version: V, record: { type: 'event_msg', 'payload.type': 'token_count' }, field: 'payload.rate_limits.limit_name', test: { oneOf: ['synthkey'] }, method: 'api-key' };
  assert.deepEqual(classify([rollout(tokenCount({ limit_name: 'synthkey' }))], [droppedCodex]), { method: 'unknown', reason: 'no-signal' });
});

test('model, tokens, cost, credits, account ids and missing quota never produce a method', () => {
  const r = (id: string, source: Rule['source'], field: string, test: Rule['test']): Rule => ({ id, source, version: V, record: {}, field, test, method: 'subscription' });
  const bad = [
    r('syn-model', 'claude-statusline', 'model.id', { oneOf: ['synthmodel'] }),
    r('syn-cost', 'claude-statusline', 'cost', { nonEmptyObject: true }),
    r('syn-context', 'claude-statusline', 'context_window.current_usage', { nonEmptyObject: true }),
    r('syn-credits', 'codex-rollout', 'payload.rate_limits.credits', { nonEmptyObject: true }),
    r('syn-tokens', 'codex-rollout', 'payload.info.total_token_usage', { nonEmptyObject: true }),
    r('syn-account', 'codex-rollout', 'payload.creator_account_id', { oneOf: ['synth'] }),
    r('syn-usage', 'claude-transcript', 'message.usage', { nonEmptyObject: true }),
    r('syn-tier', 'claude-transcript', 'message.usage.service_tier', { oneOf: ['standard'] }),
  ];
  for (const b of bad) assert.ok(ruleIssues(b).includes('excluded-field'), b.id);
  const rec = { model: { id: 'synthmodel' }, cost: { total_cost_usd: 1 }, context_window: { current_usage: { input_tokens: 1 } } };
  assert.equal(classify([statusline(rec)], bad).method, 'unknown');
  // missing quota: a statusLine with no rate_limits under a rule for it is Unknown, never "API key"
  assert.deepEqual(classify([statusline({ model: { id: 'synthmodel' } })], RULES), { method: 'unknown', reason: 'no-signal' });
});

test('malformed rules are refused and never match', () => {
  const base: Rule = { id: 'syn-ok', source: 'claude-statusline', version: V, record: {}, field: 'rate_limits.five_hour', test: { nonEmptyObject: true }, method: 'subscription' };
  const cases: [Partial<Rule> & Record<string, unknown>, string][] = [
    [{ id: 'Bad Id 1' }, 'bad-id'], [{ version: '>=1.0.0' }, 'bad-version'], [{ version: 'unverified' }, 'bad-version'],
    [{ source: 'claude-env' as never }, 'bad-source'], [{ field: 'a..b' }, 'bad-field'], [{ field: '__proto__.x' }, 'bad-field'],
    [{ test: { oneOf: [] } }, 'bad-test'], [{ test: { oneOf: ['a b'] } }, 'bad-test'], [{ test: { regex: '.*' } as never }, 'bad-test'],
    [{ method: 'guess' as never }, 'bad-method'], [{ record: { type: 'x y' } }, 'bad-record'],
    [{ record: { 'model.id': 'x' } }, 'excluded-field'], [{ record: { 'payload.creator_account_id': 'y' } }, 'excluded-field'],
  ];
  for (const [patch, code] of cases) {
    const rule = { ...base, ...patch } as Rule;
    assert.ok(ruleIssues(rule).includes(code), code + ' ' + JSON.stringify(patch));
    assert.deepEqual(classify([statusline(window5h)], [rule]).method, 'unknown', code);
  }
});

test('conflicting signals are Unknown with a reason, never collapsed into Mixed', () => {
  assert.deepEqual(classify([plan('synthplus'), plan('synthkey')], RULES), { method: 'unknown', reason: 'conflict' });
  assert.deepEqual(classify([plan('synthmixed'), plan('synthplus')], RULES), { method: 'unknown', reason: 'conflict' });
});

test('transcripts are not projected until P6-T01a wires their production parsers: no transcript rule can match', () => {
  const rule: Rule = { id: 'syn-transcript-type', source: 'claude-transcript', version: V, record: {}, field: 'type', test: { oneOf: ['assistant'] }, method: 'subscription' };
  assert.deepEqual(classify([{ source: 'claude-transcript', version: V, raw: JSON.stringify({ type: 'assistant' }) }], [rule]), { method: 'unknown', reason: 'no-signal' });
});

test('agy and Claude transcripts have no candidate rule: Unknown', () => {
  const agy: Observation = { source: 'agy-transcript', version: V, raw: JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 1, output_tokens: 1 }) };
  assert.deepEqual(classify([agy], RULES), { method: 'unknown', reason: 'unsupported-version' });
});

// EC-110 shape for the spike: synthetic credential/auth/config canaries next to the run; trace every file, process,
// network and environment access while classifying and serializing.
test('privacy: no file, environment, spawn or network access; no canary in any output', () => {
  const canary = 'xcanary' + Math.random().toString(36).slice(2);
  const home = mkdtempSync(join(tmpdir(), 's14-canary-'));
  for (const f of ['.claude/.credentials.json', '.claude/settings.json', '.codex/auth.json', '.codex/config.toml', '.gemini/oauth_creds.json']) {
    mkdirSync(join(home, f, '..'), { recursive: true });
    writeFileSync(join(home, f), JSON.stringify({ token: canary }));
  }
  const keychain = { find: () => canary }; // fake keychain accessor: never handed to the classifier, so never called
  const calls: string[] = [];
  const saved: [Record<string, unknown>, string, unknown][] = [];
  const trap = (mod: Record<string, unknown>, name: string, names: string[]) => {
    for (const n of names) if (typeof mod[n] === 'function') { saved.push([mod, n, mod[n]]); mod[n] = (...a: unknown[]) => { calls.push(name + '.' + n); throw new Error('blocked ' + String(a[0])); }; }
  };
  const fsDefault = (fs as unknown as { default: Record<string, unknown> }).default;
  trap(fsDefault, 'fs', ['readFileSync', 'readFile', 'openSync', 'open', 'statSync', 'stat', 'lstatSync', 'lstat', 'existsSync', 'readdirSync', 'readdir', 'accessSync', 'access', 'realpathSync', 'createReadStream']);
  trap(fsDefault.promises as Record<string, unknown>, 'fs.promises', ['readFile', 'open', 'stat', 'lstat', 'readdir', 'access']);
  trap((cp as unknown as { default: Record<string, unknown> }).default, 'child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
  for (const [m, n] of [[net, 'net'], [http, 'http'], [https, 'https'], [dns, 'dns']] as const) trap((m as unknown as { default: Record<string, unknown> }).default, n, ['connect', 'createConnection', 'request', 'get', 'lookup', 'resolve']);
  syncBuiltinESMExports();
  const realEnv = process.env;
  process.env = new Proxy({ ...realEnv, ANTHROPIC_API_KEY: canary, OPENAI_API_KEY: canary, HOME: home }, {
    get(t, k) { calls.push('env.' + String(k)); return Reflect.get(t, k); },
    has(t, k) { calls.push('env.' + String(k)); return Reflect.has(t, k); },
    ownKeys(t) { calls.push('env.*'); return Reflect.ownKeys(t); },
  });
  let out = '';
  try {
    const recs = [statusline({ ...window5h, api_key: canary, session_id: canary }), plan(canary), plan('synthplus'),
      rollout({ type: 'session_meta', payload: { creator_account_id: canary } })];
    out = JSON.stringify([classify(recs, RULES), classify([plan(canary)], RULES), classify(recs.slice(0, 1), RULES)]);
    out += serialize([{ agent: 'claude', version: '1.0.0', method: 'subscription', surface: 'claude-statusline', fields: ['rate_limits.five_hour'],
      predicate: 'syn-claude-five-hour', signal: 'present', repeatable: 'yes', result: 'verified', guard: 'MATCH', reachable: 'yes', reason: 'none', raw: canary }]);
  } finally {
    process.env = realEnv;
    for (const [m, n, f] of saved) m[n] = f;
    syncBuiltinESMExports();
  }
  assert.deepEqual(calls, []);
  assert.ok(!out.includes(canary));
  assert.equal(typeof keychain.find, 'function');
});

// Report: numberless, allowlisted rows only (design "Numberless report format").
const row = { agent: 'claude', version: '2.1.322', method: 'subscription', surface: 'claude-statusline', fields: ['rate_limits.five_hour'],
  predicate: 'claude-five-hour-window', signal: 'present', repeatable: 'yes', result: 'verified', guard: 'MATCH', reachable: 'yes', reason: 'alternatives-not-run' };

test('report: only the allowlisted columns, in order; extra keys dropped', () => {
  const out = JSON.parse(serialize([{ ...row, raw: 'x', used_percentage: 12, session_id: 's' }]));
  assert.deepEqual(out, [row]);
  assert.deepEqual(Object.keys(out[0]), Object.keys(row));
});

test('report: a row with a live value, a number outside the version or a bad enum becomes invalid', () => {
  const invalid = { result: 'invalid', reason: 'malformed-row' };
  for (const patch of [{ reason: 'used 12%' }, { predicate: 'rule-1' }, { fields: ['rate_limits.five_hour', 'value 12'] }, { signal: 'maybe' },
    { version: '2.1' }, { agent: 'gemini' }, { guard: 'MATCH 3' }, { fields: 'rate_limits' }, { predicate: '' }]) {
    assert.deepEqual(JSON.parse(serialize([{ ...row, ...patch }])), [invalid], JSON.stringify(patch));
  }
  assert.deepEqual(JSON.parse(serialize([{ ...row, predicate: null, fields: [] }])), [{ ...row, predicate: null, fields: [] }]);
  assert.deepEqual(JSON.parse(serialize([{ ...row, version: 'unavailable', result: 'not-run', guard: 'not-run' }]))[0].version, 'unavailable');
});

test('report: malformed input and a failing row never throw and never echo input', () => {
  assert.equal(serialize(null), '[]');
  assert.equal(serialize({ rows: 1 }), '[]');
  assert.deepEqual(JSON.parse(serialize([null, 7, 'x'])), [{ result: 'invalid', reason: 'malformed-row' }, { result: 'invalid', reason: 'malformed-row' }, { result: 'invalid', reason: 'malformed-row' }]);
  const boom = { ...row, get reason(): string { throw new Error('xsecret'); } };
  const out = serialize([boom]);
  assert.ok(!out.includes('xsecret'));
  assert.deepEqual(JSON.parse(out), [{ result: 'invalid', reason: 'serializer-failed' }]);
});

// Collection: bounded, regular files inside the approved root only; the statusLine capture keeps the production
// projection and key names, never another value.
test('capture: production projection plus key names; values outside the allowlist dropped; bad input writes nothing', () => {
  const line = captureLine(JSON.stringify({ ...window5h, api_key: 'xsecretvalue', workspace: { current_dir: '/tmp/xaibo-fixture/p' } }));
  assert.ok(line && !line.includes('xsecretvalue') && !line.includes('/tmp/xaibo-fixture'));
  const parsed = JSON.parse(line!);
  assert.deepEqual(parsed.record, { rate_limits: { five_hour: { used_percentage: 12, resets_at: 1767225600 } } });
  assert.deepEqual(parsed.keys, ['api_key', 'rate_limits.five_hour.resets_at', 'rate_limits.five_hour.used_percentage', 'workspace.current_dir']);
  assert.equal(captureLine('{not json'), null);
  assert.equal(captureLine('x'.repeat(300 * 1024)), null);
});

test('readBounded: regular files inside the root; oversize is truncated (invalid coverage); links and outside paths read nothing', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 's14-read-')));
  const root = join(tmp, 'root');
  mkdirSync(root);
  writeFileSync(join(tmp, 'outside.jsonl'), '{"o":1}\n');
  writeFileSync(join(root, 'ok.jsonl'), '{"a":1}\n\n{bad\n{"b":2}\n');
  writeFileSync(join(root, 'big.jsonl'), '{"a":1}\n'.repeat(100));
  symlinkSync(join(tmp, 'outside.jsonl'), join(root, 'link.jsonl'));
  assert.deepEqual(readBounded(root, join(root, 'ok.jsonl'), 1024), { lines: ['{"a":1}', '{bad', '{"b":2}'], truncated: false });
  assert.deepEqual(readBounded(root, join(root, 'big.jsonl'), 64), { lines: [], truncated: true });
  assert.deepEqual(readBounded(root, join(root, 'link.jsonl'), 1024), { lines: [], truncated: false });
  assert.deepEqual(readBounded(root, join(tmp, 'outside.jsonl'), 1024), { lines: [], truncated: false });
  assert.deepEqual(readBounded(root, join(root, 'missing.jsonl'), 1024), { lines: [], truncated: false });
});

test('rowsFor: a start with no captured record is invalid (collection-empty), never a negative', () => {
  const rule: Rule = { id: 'claude-five-hour-window', source: 'claude-statusline', version: 'unverified', record: {}, field: 'rate_limits.five_hour', test: { nonEmptyObject: true }, method: 'subscription' };
  const base = { agent: 'claude' as const, version: '2.1.322', method: 'subscription' as const, rules: [rule], guard: 'MATCH' as const, truncated: false };
  for (const starts of [[[], []], [[JSON.stringify(window5h)], []], []]) {
    const [r] = rowsFor({ ...base, starts });
    assert.deepEqual([r!.result, r!.reason], ['invalid', 'collection-empty'], JSON.stringify(starts));
  }
  assert.deepEqual([rowsFor({ ...base, rules: [], starts: [[], []] })[0]!.result], ['invalid']);
});

test('under: a symlinked collection root that leaves the profile is refused', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 's14-under-')));
  mkdirSync(join(tmp, 'profile', 'home'), { recursive: true });
  mkdirSync(join(tmp, 'elsewhere'));
  mkdirSync(join(tmp, 'profile', 'home', 'real'));
  symlinkSync(join(tmp, 'elsewhere'), join(tmp, 'profile', 'home', 'linked'));
  assert.equal(under(join(tmp, 'profile'), join(tmp, 'profile', 'home', 'real')), true);
  assert.equal(under(join(tmp, 'profile'), join(tmp, 'profile', 'home', 'linked')), false);
  assert.equal(under(join(tmp, 'profile'), join(tmp, 'profile', 'home', 'missing')), false);
});

test('keyNames: identifier paths only; any digit or other text is dropped', () => {
  assert.deepEqual(keyNames(['b.c', 'a', 'a', 'x.ephemeral_5m', 'model claude', 'tool.mcp__x[]', '1abc']), ['a', 'b.c', 'tool.mcp__x[]']);
});

test('rowsFor: present in both starts = repeatable; one start = not repeatable; none = negative; alternatives stay unrun', () => {
  const rule: Rule = { id: 'claude-five-hour-window', source: 'claude-statusline', version: 'unverified', record: {}, field: 'rate_limits.five_hour', test: { nonEmptyObject: true }, method: 'subscription' };
  const s = (o: unknown) => JSON.stringify(o);
  const base = { agent: 'claude' as const, version: '2.1.322', method: 'subscription' as const, rules: [rule], guard: 'MATCH' as const, truncated: false };
  assert.deepEqual(rowsFor({ ...base, starts: [[s(window5h)], [s(window5h)]] }), [{ ...row, predicate: 'claude-five-hour-window' }]);
  assert.deepEqual(rowsFor({ ...base, starts: [[s(window5h)], [s({})]] })[0], { ...row, predicate: 'claude-five-hour-window', repeatable: 'no', result: 'negative', reason: 'not-repeatable' });
  assert.deepEqual(rowsFor({ ...base, starts: [[s({})], [s({ rate_limits: { five_hour: null } })]] })[0],
    { ...row, predicate: 'claude-five-hour-window', signal: 'absent', repeatable: 'unavailable', result: 'negative', reason: 'signal-absent' });
  assert.equal(rowsFor({ ...base, truncated: true, starts: [[s(window5h)], [s(window5h)]] })[0]!.result, 'invalid');
  assert.equal(rowsFor({ ...base, starts: [[s(window5h)]] })[0]!.repeatable, 'unavailable');
  assert.deepEqual(rowsFor({ ...base, rules: [], starts: [[s(window5h)], [s(window5h)]] }),
    [{ ...row, fields: [], predicate: null, signal: 'absent', repeatable: 'unavailable', result: 'negative', reason: 'no-candidate' }]);
});
