// P3-T07 replay (PRD §6.6/§6.7, M8). Harness self-test (seeded interleavings are deterministic), fixture well-formedness,
// B1/B2 FP/FN per fixture, and the status engine against the replay set: per-step lifecycle, order invariance over the 10
// interleavings, FP/FN <= B1 and B2. RED until P3-T08 adds src/service/status/engine.ts. Findings run as todo until P3-T09
// (rules), agy and report/v1 fixtures until P3-T13 (mappings).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { b1, b2, score } from './replay-baselines.ts';
import { CONFIDENCES, HEALTHS, INTERLEAVINGS, isObs, LIFECYCLES, canonical, loadAll, replay, schedules,
  type EngineFactory, type Expect, type Fixture, type SessionStatus } from './replay-harness.ts';

const ALL = loadAll();
const REPLAYABLE = ALL.filter((f) => !f.unavailable);
const byId = new Map(ALL.map((f) => [f.id, f]));

const COMMON = ['simple-turn', 'permission-granted', 'permission-denied-manual', 'permission-denied-auto', 'idle-prompt',
  'needs-input-accepted', 'needs-input-declined', 'needs-input-cancelled', 'tool-failure', 'stop-failure', 'subagent',
  'background-after-stop', 'compaction', 'worktree-relocation', 'interrupted-turn', 'legit-15min-build', 'repeated-tool',
  'repeated-error', 'cycle-2', 'cycle-3', 'sleep-wake-gap', 'pre-hook-session', 'concurrent-resume', 'format-drift'];
const REQUIRED = [
  ...COMMON.map((c) => `claude/2.1.322/${c}`),
  // Codex 0.160.0 has no Notification/Elicitation/StopFailure hooks: idle reminder and StopFailure do not apply.
  ...COMMON.filter((c) => c !== 'idle-prompt' && c !== 'stop-failure').map((c) => `codex/0.160.0/${c}`),
  ...['simple-invocation', 'two-invocations', 'tool-pairing', 'canary', 'stop-settle', 'model-name', 'unverified'].map((c) => `agy/1.5.6/${c}`),
  ...['lifecycle-exchange', 'duplicate-retry', 'out-of-order', 'interrupted-chunks', 'generic-notification', 'unmatched-resolution']
    .map((c) => `report/v1/${c}`),
];

test('fixtures: the required replay set is present (§6.6)', () => {
  assert.deepEqual(REQUIRED.filter((id) => !byId.has(id)), []);
});

test('harness: the 10 interleavings are deterministic for a seed and depend on it', () => {
  for (const fx of REPLAYABLE) {
    const a = schedules(fx, 7);
    assert.deepEqual(a, schedules(fx, 7), fx.id);
    assert.deepEqual(a.map((s) => s.name), ['canonical', ...INTERLEAVINGS], fx.id);
  }
  const differs = REPLAYABLE.some((fx) => JSON.stringify(schedules(fx, 7)) !== JSON.stringify(schedules(fx, 8)));
  assert.ok(differs, 'some schedule changes with the seed');
});

test('harness: interleavings keep every observation, duplicate only hooks, and place restart and sleep inside the stream', () => {
  for (const fx of REPLAYABLE) {
    const obs = fx.steps.flatMap((s, i) => (isObs(s) ? [i] : []));
    const hookish = (i: number) => ['hook', 'report'].includes(fx.streams[(fx.steps[i] as { src: string }).src]!.source);
    const steps = (name: string) => schedules(fx).find((s) => s.name === name)!.actions.flatMap((a) => (a.kind === 'obs' ? [a.step] : []));
    for (const name of ['hooks-first', 'files-first', 'otel-late', 'rapid-distinct', 'delayed-earlier', 'restart', 'sleep-gap']) {
      assert.deepEqual([...steps(name)].sort((x, y) => x - y), obs, `${fx.id} ${name}`);
    }
    assert.deepEqual(steps('hooks-missing'), obs.filter((i) => !hookish(i)), fx.id);
    for (const name of ['duplicated-hooks', 'duplicate-spool-replay']) {
      assert.deepEqual([...steps(name)].sort((x, y) => x - y), [...obs, ...obs.filter(hookish)].sort((x, y) => x - y), `${fx.id} ${name}`);
    }
    for (const s of schedules(fx)) {
      const ats = s.actions.map((a) => a.at);
      assert.deepEqual(ats, [...ats].sort((x, y) => x - y), `${fx.id} ${s.name}: arrival times never go back`);
    }
    const spool = schedules(fx).find((s) => s.name === 'duplicate-spool-replay')!.actions;
    const firstReplay = spool.length - obs.filter(hookish).length;
    if (firstReplay < spool.length) assert.ok(Math.floor(spool[firstReplay]!.at / 1000) > Math.floor(spool[firstReplay - 1]!.at / 1000), fx.id);
    const restart = schedules(fx).find((s) => s.name === 'restart')!.actions;
    assert.equal(restart.filter((a) => a.kind === 'restart').length, 1, fx.id);
    const sleep = schedules(fx).find((s) => s.name === 'sleep-gap')!.actions;
    const sus = sleep.find((a) => a.kind === 'suspend')!, res = sleep.find((a) => a.kind === 'resume')!;
    assert.ok(res.at - sus.at >= 3600_000, fx.id);
  }
});

const validExpect = (fx: Fixture, e: Expect, where: string) => {
  assert.ok(LIFECYCLES.includes(e.lifecycle), `${where} lifecycle`);
  assert.ok(CONFIDENCES.includes(e.confidence), `${where} confidence`);
  assert.ok(e.reason === null || typeof e.reason === 'string', `${where} reason`);
  if (e.health !== undefined) assert.ok(HEALTHS.includes(e.health), `${where} health`);
  if (e.session !== undefined) assert.ok(fx.sessions.includes(e.session), `${where} session`);
};

for (const fx of ALL) {
  test(`fixture ${fx.id}: well-formed`, () => {
    if (fx.unavailable) {
      assert.deepEqual([fx.steps.length, Object.keys(fx.streams).length], [0, 0], 'an unavailable case carries no streams');
      assert.ok(fx.unavailable.length > 20, 'an unavailable case names its evidence');
      return;
    }
    assert.ok(fx.sessions.length > 0);
    assert.deepEqual(Object.keys(fx.final).sort(), [...fx.sessions].sort());
    const seen = new Map<string, number[]>();
    let at = -Infinity;
    fx.steps.forEach((s, i) => {
      assert.ok(s.at >= at, `step ${i}: time never goes back`);
      at = s.at;
      if (isObs(s)) {
        assert.ok(fx.lines[s.src]?.[s.line] !== undefined, `step ${i}: ${s.src}:${s.line} exists`);
        seen.set(s.src, [...(seen.get(s.src) ?? []), s.line]);
        validExpect(fx, s.expect, `step ${i}`);
      } else if ('expect' in s && s.expect) validExpect(fx, s.expect, `step ${i}`);
    });
    for (const [k, ls] of Object.entries(fx.lines)) {
      assert.deepEqual(seen.get(k), ls.map((_, i) => i), `every line of ${k} is replayed once, in order`);
      if (fx.streams[k]!.source !== 'file') for (const l of ls) JSON.parse(l);
    }
  });
}

test('baselines: B1 and B2 false positives and negatives per fixture (§6.6)', async (t) => {
  for (const fx of REPLAYABLE) {
    const [r1, r2] = [await replay(b1, fx, canonical(fx)), await replay(b2, fx, canonical(fx))];
    const [s1, s2] = [score(fx, r1), score(fx, r2)];
    t.diagnostic(`${fx.id}: B1 FP ${s1.fp} FN ${s1.fn} | B2 FP ${s2.fp} FN ${s2.fn}`);
  }
});

// ---- Engine (P3-T08) --------------------------------------------------------------------------------------------------

const ENGINE = new URL('../../src/service/status/engine.ts', import.meta.url).href;
async function engine(): Promise<EngineFactory | null> {
  try { return ((await import(ENGINE)) as { createEngine: EngineFactory }).createEngine; } catch { return null; }
}

const pick = (s: SessionStatus | null | undefined, e: Expect, findings: boolean) => {
  if (!s) return null;
  const out: Record<string, unknown> = { lifecycle: s.lifecycle, confidence: s.confidence, reason: s.reason };
  if (e.outcome !== undefined) out['outcome'] = s.outcome;
  if (e.health !== undefined) out['health'] = s.health;
  if (findings) out['findings'] = s.findings;
  return out;
};
const want = (e: Expect, findings: boolean) => {
  const out: Record<string, unknown> = { lifecycle: e.lifecycle, confidence: e.confidence, reason: e.reason };
  if (e.outcome !== undefined) out['outcome'] = e.outcome;
  if (e.health !== undefined) out['health'] = e.health;
  if (findings) out['findings'] = e.findings ?? [];
  return out;
};
const invariantPart = (s: SessionStatus | null | undefined) => (s ? { lifecycle: s.lifecycle, toolCalls: s.toolCalls, usage: s.usage } : null);

async function check(t: TestContext, factory: EngineFactory, fx: Fixture, findings: boolean) {
  const all = schedules(fx);
  const runs = new Map<string, Awaited<ReturnType<typeof replay>>>();
  for (const s of all) runs.set(s.name, await replay(factory, fx, s));
  const canon = runs.get('canonical')!;

  fx.steps.forEach((step, i) => {
    const e = (step as { expect?: Expect }).expect;
    if (!e || (findings && e.findings === undefined)) return;
    assert.deepEqual(pick(canon.perStep.get(i), e, findings), want(e, findings), `${fx.id} step ${i}`);
  });
  if (findings) return;

  for (const [sid, f] of Object.entries(fx.final)) {
    const got = canon.final[sid];
    assert.ok(got, `${fx.id} ${sid}: final status`);
    const keys = Object.keys(f) as (keyof typeof f)[];
    assert.deepEqual(Object.fromEntries(keys.map((k) => [k, got[k]])), f, `${fx.id} ${sid}: final`);
  }
  for (const s of all.filter((x) => x.invariant && x.name !== 'canonical')) {
    for (const sid of fx.sessions) {
      assert.deepEqual(invariantPart(runs.get(s.name)!.final[sid]), invariantPart(canon.final[sid]), `${fx.id} ${s.name} ${sid}: order invariance`);
    }
  }
  if (fx.hooksMissing) {
    for (const [sid, f] of Object.entries(fx.hooksMissing)) {
      const got = runs.get('hooks-missing')!.final[sid];
      assert.deepEqual(got && { lifecycle: got.lifecycle, confidence: got.confidence }, f, `${fx.id} ${sid}: hooks-missing final`);
    }
  }
  const x = score(fx, canon);
  const [s1, s2] = [score(fx, await replay(b1, fx, canonical(fx))), score(fx, await replay(b2, fx, canonical(fx)))];
  t.diagnostic(`${fx.id}: Xaibo FP ${x.fp} FN ${x.fn} | B1 FP ${s1.fp} FN ${s1.fn} | B2 FP ${s2.fp} FN ${s2.fn}`);
  assert.ok(x.fp <= Math.min(s1.fp, s2.fp) && x.fn <= Math.min(s1.fn, s2.fn), `${fx.id}: FP/FN <= B1 and B2`);
  if (fx.canary) {
    for (const r of runs.values()) {
      assert.ok(!r.logs.some((l) => l.includes(fx.canary!)), `${fx.id}: canary absent from logs`);
      assert.ok(!JSON.stringify([...r.perStep.values(), r.final]).includes(fx.canary), `${fx.id}: canary absent from status`);
    }
  }
}

const set = (needs: boolean) => REPLAYABLE.filter((f) => Boolean(f.needs) === needs);

test('engine (P3-T08): Claude and Codex replay set, order invariance, FP/FN <= B1 and B2', async (t) => {
  const factory = await engine();
  assert.ok(factory, 'P3-T08 status engine absent (src/service/status/engine.ts createEngine)');
  for (const fx of set(false)) await t.test(fx.id, (tt) => check(tt, factory, fx, false));
});

test('engine (P3-T09): findings per step', { todo: 'P3-T09 stuck/loop rules' }, async (t) => {
  const factory = await engine();
  assert.ok(factory, 'P3-T08 status engine absent');
  for (const fx of set(false)) await t.test(fx.id, (tt) => check(tt, factory, fx, true));
});

test('engine (P3-T13): agy and report/v1 replay set', { todo: 'P3-T13 agy and report mappings' }, async (t) => {
  const factory = await engine();
  assert.ok(factory, 'P3-T08 status engine absent');
  for (const fx of set(true)) await t.test(fx.id, (tt) => check(tt, factory, fx, false));
});
