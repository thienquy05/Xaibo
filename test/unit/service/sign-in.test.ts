// XAIBO-PROD-570 (P6-T01a slice 1; S-38, FR-54, EC-109 shape; design .handoff/p6-t01a-design.md, S14 D-P6-15): the
// sign-in rule contract and the pure evaluator. Synthetic rules only: the bundled catalog ships none (Pass-narrowed), so
// these tests certify behaviour, never a live field-to-method mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateMethod, type MethodRule, type MethodObservation } from '../../../src/service/usage/sign-in.ts';
import { catalogIssues, loadCatalog, type Catalog } from '../../../src/service/catalog/validate.ts';
import { importCatalog } from '../../../src/service/catalog/import.ts';

const V = '0.160.0';
const rule = (over: Partial<MethodRule> = {}): MethodRule => ({ id: 'syn-plan-subscription', source: 'codex-rollout', version: V,
  record: { type: 'event_msg', 'payload.type': 'token_count' }, field: 'payload.rate_limits.plan_type', test: { oneOf: ['synthplus'] }, method: 'subscription', ...over });
const RULES: MethodRule[] = [
  rule(),
  rule({ id: 'syn-plan-key', test: { oneOf: ['synthkey'] }, method: 'api-key' }),
  rule({ id: 'syn-plan-cloud', test: { oneOf: ['synthcloud'] }, method: 'cloud-provider' }),
  rule({ id: 'syn-plan-gateway', test: { oneOf: ['synthgateway'] }, method: 'gateway' }),
  rule({ id: 'syn-plan-mixed', test: { oneOf: ['synthmixed'] }, method: 'mixed' }),
];
const codex = (plan: unknown, version: string | null = V): MethodObservation =>
  ({ source: 'codex-rollout', version, projected: { type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: plan } } } });
const claude = (projected: Record<string, unknown>, version: string | null = '2.1.332'): MethodObservation => ({ source: 'claude-statusline', version, projected });

test('each method matches only its explicit rule', () => {
  assert.deepEqual(evaluateMethod(codex('synthplus'), RULES), { kind: 'matched', method: 'subscription', ruleId: 'syn-plan-subscription' });
  assert.deepEqual(evaluateMethod(codex('synthkey'), RULES), { kind: 'matched', method: 'api-key', ruleId: 'syn-plan-key' });
  assert.deepEqual(evaluateMethod(codex('synthcloud'), RULES), { kind: 'matched', method: 'cloud-provider', ruleId: 'syn-plan-cloud' });
  assert.deepEqual(evaluateMethod(codex('synthgateway'), RULES), { kind: 'matched', method: 'gateway', ruleId: 'syn-plan-gateway' });
  assert.deepEqual(evaluateMethod(codex('synthmixed'), RULES), { kind: 'matched', method: 'mixed', ruleId: 'syn-plan-mixed' });
});

test('absent, null, empty, malformed or unknown values are no-signal', () => {
  for (const p of [undefined, null, '', 7, ['synthplus'], { v: 'synthplus' }, 'synthother', 'SYNTHPLUS']) {
    assert.deepEqual(evaluateMethod(codex(p), RULES), { kind: 'unknown', reason: 'no-signal' }, String(p));
  }
  assert.deepEqual(evaluateMethod({ source: 'codex-rollout', version: V, projected: {} }, RULES), { kind: 'unknown', reason: 'no-signal' });
});

test('exact version only, prerelease included; a missing version never matches', () => {
  for (const v of [null, '0.160.1', '0.160', '0.160.0-alpha.1', ' 0.160.0', 7 as never]) assert.deepEqual(evaluateMethod(codex('synthplus', v), RULES), { kind: 'unknown', reason: 'unsupported-version' }, String(v));
  const pre = [rule({ version: '0.160.0-alpha.1' })];
  assert.equal(evaluateMethod(codex('synthplus', '0.160.0-alpha.1'), pre).kind, 'matched');
  assert.deepEqual(evaluateMethod(codex('synthplus'), pre), { kind: 'unknown', reason: 'unsupported-version' });
  assert.deepEqual(evaluateMethod(codex('synthplus'), []), { kind: 'unknown', reason: 'unsupported-version' });
});

test('wrong record discriminator, text-only mentions and inherited properties never match', () => {
  const o = (projected: Record<string, unknown>): MethodObservation => ({ source: 'codex-rollout', version: V, projected });
  const none = { kind: 'unknown', reason: 'no-signal' };
  assert.deepEqual(evaluateMethod(o({ type: 'response_item', payload: { type: 'token_count', rate_limits: { plan_type: 'synthplus' } } }), RULES), none);
  assert.deepEqual(evaluateMethod(o({ type: 'event_msg', payload: { type: 'agent_message', rate_limits: { plan_type: 'synthplus' } } }), RULES), none);
  assert.deepEqual(evaluateMethod(o({ type: 'event_msg', payload: { type: 'token_count', text: '"plan_type":"synthplus"' } }), RULES), none);
  const inherited = Object.create({ plan_type: 'synthplus' }) as Record<string, unknown>;
  assert.deepEqual(evaluateMethod(o({ type: 'event_msg', payload: { type: 'token_count', rate_limits: inherited } }), RULES), none);
  assert.deepEqual(evaluateMethod(o({ payload: { type: 'token_count', rate_limits: { plan_type: 'synthplus' } } }), RULES), none);
  assert.deepEqual(evaluateMethod(o({ type: 'event_msg', payload: { rate_limits: { plan_type: 'synthplus' } } }), RULES), none);
  const protoType = Object.create({ type: 'event_msg' }) as Record<string, unknown>;
  protoType.payload = { type: 'token_count', rate_limits: { plan_type: 'synthplus' } };
  assert.deepEqual(evaluateMethod(o(protoType), RULES), none);
});

test('surfaces with no eligible field (Claude statusLine, transcripts) are unsupported; rules of another source or outside the allowlist are ignored', () => {
  for (const source of ['claude-statusline', 'claude-transcript', 'agy-transcript'] as const) {
    assert.deepEqual(evaluateMethod({ source, version: V, projected: { type: 'x', rate_limits: { five_hour: { used_percentage: 1 } } } },
      [rule({ source, record: {}, field: 'type', test: { oneOf: ['x'] } })]), { kind: 'unknown', reason: 'unsupported-surface' }, source);
  }
  assert.deepEqual(evaluateMethod(codex('synthplus'), [rule({ source: 'claude-statusline' })]), { kind: 'unknown', reason: 'unsupported-version' });
  const sneaky = { source: 'codex-rollout' as const, version: V, projected: { type: 'event_msg', payload: { type: 'token_count', model: 'synthplus' } } };
  assert.deepEqual(evaluateMethod(sneaky, [rule({ field: 'payload.model' })]), { kind: 'unknown', reason: 'unsupported-version' });
  assert.deepEqual(evaluateMethod(codex('synthplus'), [rule({ record: { 'payload.model': 'x' } })]), { kind: 'unknown', reason: 'unsupported-version' });
  assert.deepEqual(evaluateMethod(codex('synthplus'), [rule({ record: {} })]), { kind: 'unknown', reason: 'unsupported-version' });
  assert.deepEqual(evaluateMethod(codex('synthplus'), [rule({ record: null as never })]), { kind: 'unknown', reason: 'unsupported-version' }); // review L3
});

test('disagreeing rules are ambiguous, never Mixed; agreeing rules report the smallest rule id', () => {
  const both = [rule(), rule({ id: 'syn-other-key', test: { oneOf: ['synthkey', 'synthplus'] }, method: 'api-key' })];
  assert.deepEqual(evaluateMethod(codex('synthplus'), both), { kind: 'unknown', reason: 'ambiguous' });
  const agree = [rule({ id: 'syn-z' }), rule({ id: 'syn-a', test: { oneOf: ['synthother', 'synthplus'] } })];
  assert.deepEqual(evaluateMethod(codex('synthplus'), agree), { kind: 'matched', method: 'subscription', ruleId: 'syn-a' });
});

// Catalog contract: rules validate as data (D-P6-09), with fixed codes and pointers.
const bundled = loadCatalog();
const withRules = (agentId: string, rules: unknown[]): Catalog => {
  const c = structuredClone(bundled);
  c.agents.find((a) => a.id === agentId)!.signInRules = rules as MethodRule[];
  return c;
};
const at = (agentId: string) => '/agents/' + bundled.agents.findIndex((a) => a.id === agentId);

test('the bundled catalog ships zero sign-in rules (S14 Pass-narrowed)', () => {
  assert.ok(bundled.agents.every((a) => !('signInRules' in a) || (a as { signInRules: unknown[] }).signInRules.length === 0));
});

test('valid synthetic rules are accepted as data; the draft version "unverified" is not', () => {
  assert.deepEqual(catalogIssues(withRules('codex', [rule(), rule({ id: 'syn-plan-key', test: { oneOf: ['synthkey'] }, method: 'api-key' })])), []);
  assert.deepEqual(catalogIssues(withRules('codex', [rule(), rule({ id: 'syn-pre', version: '0.160.0-alpha.1' })])), []);
  assert.deepEqual(catalogIssues(withRules('codex', [rule({ version: 'unverified' })])), [{ code: 'schema-invalid', at: at('codex') + '/signInRules/0/version' }]);
});

test('only allowlisted fields and discriminators are eligible (model, tokens, cost, credits, account, quota windows and limit ids are not)', () => {
  const p = at('codex') + '/signInRules/0';
  for (const field of ['payload.model', 'payload.info.total_token_usage', 'payload.rate_limits.credits', 'payload.creator_account_id', 'payload.usage.service_tier',
    'payload.effort', 'payload.session_id', 'payload.user_id', 'payload.rate_limits.limit_id', 'payload.rate_limits.primary', 'payload.model_name', 'payload.total_cost_usd', 'type']) {
    assert.deepEqual(catalogIssues(withRules('codex', [rule({ field })])), [{ code: 'unsafe-value', at: p + '/field' }], field);
  }
  // code review L2: a Codex rule names both discriminators, so it can never match another record type
  for (const record of [{}, { type: 'event_msg' }, { 'payload.type': 'token_count' }] as Record<string, string>[]) {
    assert.deepEqual(catalogIssues(withRules('codex', [rule({ record })])), [{ code: 'unsafe-value', at: p + '/record' }], JSON.stringify(record));
  }
  for (const key of ['payload.model', 'payload.account_id', 'cost', 'payload.rate_limits.plan_type']) {
    assert.deepEqual(catalogIssues(withRules('codex', [rule({ record: { type: 'event_msg', 'payload.type': 'token_count', [key]: 'x' } })])), [{ code: 'unsafe-value', at: p + '/record' }], key);
  }
});

test('shape and bounds are schema-invalid; prototype paths never pass', () => {
  const p = at('codex') + '/signInRules/0';
  const cases: [Partial<MethodRule> & Record<string, unknown>, string][] = [
    [{ id: 'Bad Id' }, '/id'], [{ version: '>=0.160.0' }, '/version'], [{ field: 'a..b' }, '/field'], [{ field: '__proto__.x' }, '/field'],
    [{ field: 'a.b.c.d.e.f.g.h.i' }, '/field'], [{ test: { oneOf: [] } }, '/test'], [{ test: { oneOf: ['a b'] } }, '/test'],
    [{ test: { oneOf: ['a', 'a'] } }, '/test'], [{ test: { nonEmptyObject: true } as never }, '/test'], [{ test: { oneOf: ['a'], nonEmptyObject: true } as never }, '/test'],
    [{ id: 'a' + '-b'.repeat(40) }, '/id'], [{ test: { oneOf: Array.from({ length: 17 }, (_, j) => 'v' + 'abcdefghijklmnopq'[j]) } }, '/test'],
    [{ method: 'unknown' as never }, '/method'], [{ record: { type: 'x y' } }, '/record'], [{ record: { constructor: 'x' } }, '/record'],
    [{ extra: 1 }, ''],
  ];
  for (const [patch, suffix] of cases) {
    const issues = catalogIssues(withRules('codex', [rule(patch)]));
    assert.ok(issues.length > 0 && issues.every((i) => i.code === 'schema-invalid' && i.at.startsWith(p + suffix)), JSON.stringify(patch) + ' ' + JSON.stringify(issues));
  }
  assert.ok(catalogIssues(withRules('codex', Array.from({ length: 33 }, (_, j) => rule({ id: 'syn-r' + 'abcdefghijklmnopqrstuvwxyzabcdefg'.slice(0, j + 1) })))).some((i) => i.at === at('codex') + '/signInRules'));
});

test('duplicate rule ids, a foreign surface and surfaces with no eligible field are refused', () => {
  const p = at('codex') + '/signInRules';
  assert.deepEqual(catalogIssues(withRules('codex', [rule(), rule({ method: 'api-key', test: { oneOf: ['synthkey'] } })])), [{ code: 'duplicate-id', at: p + '/1/id' }]);
  assert.deepEqual(catalogIssues(withRules('codex', [rule({ source: 'claude-statusline', record: {}, field: 'rate_limits.five_hour' })])), [{ code: 'unsafe-value', at: p + '/0/source' }]);
  for (const source of ['claude-statusline', 'claude-transcript'] as const) {
    assert.deepEqual(catalogIssues(withRules('claude', [rule({ source, record: {}, field: 'type', test: { oneOf: ['x'] } })])), [{ code: 'unsafe-value', at: at('claude') + '/signInRules/0/source' }], source);
  }
});

test('issues never echo submitted literals or record keys', () => {
  for (const r of [rule({ id: 'Canary Id', test: { oneOf: ['canary literal'] }, record: { 'payload.model': 'canaryvalue' } }),
    rule({ record: { canarykeyzz: 'canary value' } }), rule({ record: { ['canary' + 'k'.repeat(300)]: 'x' } })]) {
    const text = JSON.stringify(catalogIssues(withRules('codex', [r])));
    assert.ok(!/canary/i.test(text), text);
  }
});

test('the bundled load path and the private import path both refuse an unsafe rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xaibo-signin-'));
  const file = join(dir, 'agents.catalog.json');
  writeFileSync(file, JSON.stringify(withRules('codex', [rule({ field: 'payload.model' })])));
  assert.throws(() => loadCatalog(new URL('file://' + file)), /unsafe-value/);
  const imported = { schemaVersion: 1, sessionKinds: [], agents: [{ id: 'synthagent', displayName: 'Synthetic Agent',
    detection: { binaries: [{ id: 'main', names: ['synthagent'], versionArgs: ['--version'] }] }, profileRoots: [{ id: 'user', base: 'home', relative: '.synthagent' }],
    signInRules: [rule()] }] };
  const r = importCatalog(join(dir, 'data'), new TextEncoder().encode(JSON.stringify(imported)), bundled);
  assert.equal(r.status, 'rejected');
  assert.deepEqual(r.status === 'rejected' ? r.issues : [], [{ code: 'unsafe-value', at: '/agents/0/signInRules' }]); // review H2: imports carry no rules
  mkdirSync(join(dir, 'data2'), { mode: 0o700 });
  const empty = importCatalog(join(dir, 'data2'), new TextEncoder().encode(JSON.stringify({ ...imported, agents: [{ ...imported.agents[0], signInRules: [] }] })), bundled);
  assert.equal(empty.status, 'imported'); // an empty list carries no rule
});

test('the evaluator performs no file, process, network or environment access', () => {
  const calls: string[] = [];
  const saved: [Record<string, unknown>, string, unknown][] = [];
  const trap = (mod: Record<string, unknown>, name: string, names: string[]) => {
    for (const n of names) if (typeof mod[n] === 'function') { saved.push([mod, n, mod[n]]); mod[n] = () => { calls.push(name + '.' + n); throw new Error('blocked'); }; }
  };
  const def = (m: unknown) => (m as { default: Record<string, unknown> }).default;
  trap(def(fs), 'fs', ['readFileSync', 'readFile', 'openSync', 'open', 'statSync', 'stat', 'lstatSync', 'lstat', 'existsSync', 'readdirSync', 'accessSync', 'realpathSync']);
  trap(def(cp), 'child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
  trap(def(net), 'net', ['connect', 'createConnection']);
  syncBuiltinESMExports();
  const env = process.env;
  process.env = new Proxy({ ...env }, { get(t, k) { calls.push('env.' + String(k)); return Reflect.get(t, k); }, ownKeys(t) { calls.push('env.*'); return Reflect.ownKeys(t); } });
  try {
    for (const o of [codex('synthplus'), codex('synthkey'), codex(null), claude({ rate_limits: { five_hour: { used_percentage: 1 } } }), codex('synthplus', null)]) evaluateMethod(o, RULES);
    evaluateMethod(codex('synthplus'), [rule({ field: 'payload.model' })]);
  } finally {
    process.env = env;
    for (const [m, n, f] of saved) m[n] = f;
    syncBuiltinESMExports();
  }
  assert.deepEqual(calls, []);
});
