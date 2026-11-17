// XAIBO-PROD-419 (P4-T08a; EC-102, FR-51): a mid-session model or effort switch reaches the session's current model on
// the hook/report paths (M1) and the file path (M2). Claude and Codex hook payloads (model string or {id}, effort string
// or {level}; a subagent's agent_id payload never), report v1 model/effort/turn_id and the statusLine tee (model.id,
// effort.level, service clock) are model evidence; a hook or report turn start with a turn id times the turn, so the
// timeline marker carries the switch time. Unexposed effort keeps the same model's recorded effort; a new model without
// effort has none. Each turn's tokens and ~$ are attributed to that turn's model on both paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { answerCost, answerMarkers, sessionsByKey } from '../../src/service/api.ts';
import { addRegistration } from '../../src/service/receivers/registrations.ts';
import { createReportIntake, NEWEST_SEQ } from '../../src/service/receivers/report.ts';
import { loadMigrations } from '../../src/service/store/db.ts';
import { priceUsage } from '../../src/service/usage/cost.ts';
import { loadModels } from '../../src/service/usage/models.ts';
import { loadPrices } from '../../src/service/usage/prices.ts';
import type { CostComponent } from '../../src/shared/ipc.ts';
import { envelope, hookStore, T0 } from '../helpers/hook-store.ts';

const models = loadModels().models;
const S = (n: string) => `00000000-0000-4000-8000-0000000e${n}`;
const NEXT = 'synthetic-codex-next';
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const sid = (db: DatabaseSync, native: string) => (db.prepare('SELECT id FROM sessions WHERE native_session_id = ?').get(native) as { id: number }).id;
const current = (db: DatabaseSync, native: string) =>
  ({ ...(db.prepare('SELECT current_model AS model, current_effort AS effort FROM sessions WHERE native_session_id = ?').get(native) as object) });
const turn = (db: DatabaseSync, native: string) =>
  ({ ...(db.prepare('SELECT started_at AS ts, model_id AS model, effort FROM turns WHERE native_turn_id = ?').get(native) as object) });
const label = (db: DatabaseSync, agent: string, profileId: string, nativeSessionId: string) =>
  sessionsByKey(db, [{ agent, profileId, nativeSessionId }], [], models)[0]?.model;
const markers = (db: DatabaseSync, native: string) =>
  answerMarkers(db, { v: 1, type: 'markers', id: 1, session: sid(db, native), cursor: null, limit: 50 }, models).markers.map((m) => [m.ts, m.model]);
const comp = (c: CostComponent[], name: CostComponent['name']) => c.find((x) => x.name === name)!;

// Distinct prices per model (owner override), Codex default tier.
const RATES = { 'gpt-6.1-sol': { input: 2, output: 8, cache_read: 0.5 }, [NEXT]: { input: 30, output: 90, cache_read: 3 } } as const;
const OVERRIDE = JSON.stringify({ schemaVersion: 1, revision: 'owner-switch', currency: 'USD', prices_as_of: '2026-11-16',
  sources: [{ id: 'owner', url: 'https://example.com/p', retrieved: '2026-11-16' }],
  models: Object.entries(RATES).map(([id, rates]) => ({ id, display_name: id === NEXT ? NEXT : 'GPT-6.1 Sol', source: 'owner', prices_verified: true,
    qualifiers: { service_tier: ['default'] }, rates })) });

/** Per turn: last usage (in, cached, out) and cumulative totals; turn A's request at +10 s, turn B's at +30 s. */
const USAGE = [
  { at: 10_000, input: 1000, cached: 600, output: 200, cum: { input: 1000, cached: 600, output: 200, total: 1200 } },
  { at: 30_000, input: 300, cached: 100, output: 50, cum: { input: 1300, cached: 700, output: 250, total: 1550 } },
];
const tokenCount = (u: (typeof USAGE)[number], n: number) => JSON.stringify({ timestamp: iso(u.at), ordinal: n, type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: u.cum.input, cached_input_tokens: u.cum.cached, cache_write_input_tokens: 0, output_tokens: u.cum.output, reasoning_output_tokens: 0, total_tokens: u.cum.total },
  last_token_usage: { input_tokens: u.input, cached_input_tokens: u.cached, cache_write_input_tokens: 0, output_tokens: u.output, reasoning_output_tokens: 0, total_tokens: u.input + u.output },
  model_context_window: 200000 } } });
const meta = (session: string) => JSON.stringify({ timestamp: iso(0), ordinal: 0, type: 'session_meta',
  payload: { id: session, timestamp: iso(0), cwd: '/tmp/xaibo-fixture/alpha', originator: 'codex-tui', cli_version: '0.160.0', source: 'cli' } });
const turnContext = (at: number, n: number, turnId: string, model: string, effort: string) => JSON.stringify({ timestamp: iso(at), ordinal: n, type: 'turn_context',
  payload: { turn_id: turnId, root_turn_id: turnId, cwd: '/tmp/xaibo-fixture/alpha', current_date: '2026-01-01', approval_policy: 'synthetic-policy',
    sandbox_policy: { type: 'danger-full-access' }, model, collaboration_mode: { mode: 'default', settings: { model, reasoning_effort: effort } } } });
const started = (at: number, n: number, turnId: string) => JSON.stringify({ timestamp: iso(at), ordinal: n, type: 'event_msg',
  payload: { type: 'task_started', turn_id: turnId, started_at: Math.floor((T0 + at) / 1000), model_context_window: 200000, collaboration_mode_kind: 'default' } });

async function codexStore() {
  const h = await hookStore();
  const root = join(h.dir, 'codex');
  h.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', ?, 'default')").run(root);
  const ingest = async (session: string, lines: string[]) => {
    const dated = join(root, 'sessions', '2026', '01', '01');
    mkdirSync(dated, { recursive: true });
    writeFileSync(join(dated, `rollout-2026-01-01T00-00-00-${session}.jsonl`), lines.join('\n') + '\n');
    const a = new CodexAdapter({ db: h.db, writer: h.writer, profileId: 'p2', root, intervalMs: 60_000 });
    await a.start();
    a.stop();
  };
  const hook = (session: string, at: number, event: string, payload: Record<string, unknown>) => h.intake.deliver(envelope({ agent: 'codex', profile_key: 'p2',
    event, session_id: session, received_ts: T0 + at, payload: { hook_event_name: event, session_id: session, ...payload } }));
  return { ...h, ingest, hook };
}

function assertPerTurnCost(db: DatabaseSync, native: string, dir: string) {
  const file = join(dir, 'models.override.json');
  writeFileSync(file, OVERRIDE);
  priceUsage(db, loadPrices({ db, overridePath: file }));
  const c = answerCost(db, { v: 1, type: 'cost', id: 2, session: sid(db, native) }, models).cost!;
  assert.deepEqual(c.groups.map((g) => [g.model, g.requests, g.priced]), [['GPT-6.1 Sol', 1, 1], [NEXT, 1, 1]], 'one group per turn model, in order');
  for (const [i, g] of c.groups.entries()) {
    const u = USAGE[i]!, r = Object.values(RATES)[i]!;
    assert.deepEqual(['uncached_input', 'cache_read', 'output'].map((n) => comp(g.components, n as CostComponent['name']).tokens), [u.input - u.cached, u.cached, u.output], g.model);
    const usd = ((u.input - u.cached) * r.input + u.cached * r.cache_read + u.output * r.output) / 1e6;
    assert.ok(Math.abs(g.components.reduce((n, x) => n + (x.usd ?? 0), 0) - usd) < 1e-12, `${g.model} ~$ from its own model's rates`);
  }
}

test('Claude hooks: model string or {id}, effort string or {level}; subagent payloads and older evidence never change it; unexposed effort kept', async () => {
  const h = await hookStore();
  const S1 = S('0001');
  const send = (at: number, event: string, payload: Record<string, unknown>) =>
    h.intake.deliver(envelope({ event, session_id: S1, received_ts: T0 + at, payload: { hook_event_name: event, session_id: S1, ...payload } }));
  assert.equal((await send(1000, 'SessionStart', { model: 'claude-opus-5-5', effort: 'high' })).status, 'accepted');
  assert.deepEqual(current(h.db, S1), { model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(label(h.db, 'claude', 'p1', S1), 'Claude Opus 5.5 · high', 'the row updates on the hook delivery (M1 path)');
  await send(2000, 'UserPromptSubmit', { model: { id: 'claude-sonnet-5-5' }, effort: { level: 'low' }, prompt: 'x' });
  assert.deepEqual(current(h.db, S1), { model: 'claude-sonnet-5-5', effort: 'low' });
  await send(3000, 'PreToolUse', { agent_id: 'sub-1', tool_use_id: 't1', tool_name: 'Bash', model: 'claude-haiku-5-5', effort: 'max' });
  assert.deepEqual(current(h.db, S1), { model: 'claude-sonnet-5-5', effort: 'low' }, "a subagent's payload is the subagent's model");
  await send(1500, 'Notification', { model: 'claude-fable-5-2' });
  assert.deepEqual(current(h.db, S1), { model: 'claude-sonnet-5-5', effort: 'low' }, 'delayed older evidence never reverts newer state');
  await send(4000, 'Stop', { model: 'claude-sonnet-5-5' });
  assert.deepEqual(current(h.db, S1), { model: 'claude-sonnet-5-5', effort: 'low' }, 'unexposed effort keeps the same model\'s effort');
  await send(5000, 'Stop', { model: 'claude-opus-5-5' });
  assert.deepEqual(current(h.db, S1), { model: 'claude-opus-5-5', effort: null }, 'a new model without effort: none, not guessed');
  for (const bad of [{ model: '' }, { model: 'x'.repeat(257) }, { model: { id: 7 } }, { model: ['claude-haiku-5-5'] }, { model: 'claude\ud800' }]) await send(6000, 'Stop', bad);
  assert.deepEqual(current(h.db, S1), { model: 'claude-opus-5-5', effort: null }, 'empty, oversized, malformed or ill-formed model is no evidence');
  // Review M2: A (high) -> B -> A without effort; A's high from long before the switch back arrives late: never filled.
  await send(200_000, 'Stop', { model: 'claude-sonnet-5-5' });
  await send(300_000, 'Stop', { model: 'claude-opus-5-5' });
  await send(1000, 'SessionStart', { model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(current(h.db, S1), { model: 'claude-opus-5-5', effort: null }, 'stale effort from before the switch back stays out');
  // Review M1: a hook time past the commit time is capped, so it cannot lock the model against later evidence.
  await send(Date.now() + 1e10 - T0, 'Stop', { model: 'claude-haiku-5-5' });
  await send(Date.now() - T0, 'Stop', { model: 'claude-sonnet-5-5' });
  assert.deepEqual(current(h.db, S1), { model: 'claude-sonnet-5-5', effort: null }, 'a future-dated hook never locks the model');
});

test('review L4/L6: only the envelope event starts a turn, never a subagent payload; a fractional hook time still gives a timed turn', async () => {
  const h = await codexStore();
  const S6 = S('0006'), TX = S('1006'), TY = S('2006'), TZ = S('3006');
  await h.hook(S6, 1000, 'UserPromptSubmit', { turn_id: TX, agent_id: 'sub-1', prompt: 'x' });
  assert.deepEqual(turn(h.db, TX), {}, 'a subagent prompt starts no parent turn');
  await h.intake.deliver(envelope({ agent: 'codex', profile_key: 'p2', event: 'Stop', session_id: S6, received_ts: T0 + 2000,
    payload: { hook_event_name: 'UserPromptSubmit', session_id: S6, turn_id: TY } }));
  assert.deepEqual(turn(h.db, TY), {}, 'a payload event name never overrides the envelope');
  await h.hook(S6, 3000.5, 'UserPromptSubmit', { turn_id: TZ, model: 'gpt-6.1-sol', prompt: 'x' });
  assert.deepEqual(turn(h.db, TZ), { ts: T0 + 3000, model: 'gpt-6.1-sol', effort: null });
  assert.deepEqual(markers(h.db, S6), [[T0 + 3000, 'GPT-6.1 Sol']]);
});

test('Codex file-only switch: turn models with effort, markers at turn start, per-turn tokens and ~$ by model', async () => {
  const h = await codexStore();
  const S2 = S('0002'), TA = S('1002'), TB = S('2002');
  await h.ingest(S2, [meta(S2), turnContext(1000, 1, TA, 'gpt-6.1-sol', 'high'), started(2000, 2, TA), tokenCount(USAGE[0]!, 3),
    turnContext(20_000, 4, TB, NEXT, 'low'), started(21_000, 5, TB), tokenCount(USAGE[1]!, 6)]);
  assert.deepEqual(current(h.db, S2), { model: NEXT, effort: 'low' });
  assert.equal(label(h.db, 'codex', 'p2', S2), `${NEXT} · low`);
  assert.deepEqual(markers(h.db, S2), [[T0 + 2000, 'GPT-6.1 Sol · high'], [T0 + 21_000, `${NEXT} · low`]]);
  assertPerTurnCost(h.db, S2, h.dir);

  // A later hook for turn B that does not expose effort keeps it; a hook-started turn C on another model has none.
  await h.hook(S2, 40_000, 'Stop', { turn_id: TB, model: NEXT });
  assert.deepEqual(current(h.db, S2), { model: NEXT, effort: 'low' });
  assert.deepEqual(turn(h.db, TB), { ts: T0 + 21_000, model: NEXT, effort: 'low' });
  // Review M3: a hook naming the file-set turn's model differently never replaces it (or drops its effort).
  await h.hook(S2, 45_000, 'Stop', { turn_id: TB, model: 'gpt-6.1-sol-alias' });
  assert.deepEqual(turn(h.db, TB), { ts: T0 + 21_000, model: NEXT, effort: 'low' });
  const TC = S('3002');
  await h.hook(S2, 50_000, 'UserPromptSubmit', { turn_id: TC, model: 'gpt-6.1-sol', prompt: 'x' });
  assert.deepEqual(current(h.db, S2), { model: 'gpt-6.1-sol', effort: null });
  assert.deepEqual(turn(h.db, TC), { ts: T0 + 50_000, model: 'gpt-6.1-sol', effort: null });
  assert.deepEqual(markers(h.db, S2).at(-1), [T0 + 50_000, 'GPT-6.1 Sol']);
});

test('Codex hook-path switch: the row updates on delivery, markers at the hook times, per-turn tokens and ~$ by the hook turn model', async () => {
  const h = await codexStore();
  const S3 = S('0003'), TA = S('1003'), TB = S('2003');
  await h.hook(S3, 2000, 'UserPromptSubmit', { turn_id: TA, model: 'gpt-6.1-sol', prompt: 'x' });
  assert.equal(label(h.db, 'codex', 'p2', S3), 'GPT-6.1 Sol');
  await h.hook(S3, 21_000, 'UserPromptSubmit', { turn_id: TB, model: NEXT, prompt: 'x' });
  assert.equal(label(h.db, 'codex', 'p2', S3), NEXT, 'the switch shows before any file line is read (M1 path)');
  assert.deepEqual(markers(h.db, S3), [[T0 + 2000, 'GPT-6.1 Sol'], [T0 + 21_000, NEXT]]);
  // The rollout names turn B's effort only, a little before the hook; turn B's file start is earlier than the hook's.
  await h.ingest(S3, [meta(S3), tokenCount(USAGE[0]!, 1), turnContext(20_400, 2, TB, NEXT, 'medium'), started(20_500, 3, TB), tokenCount(USAGE[1]!, 4)]);
  assert.deepEqual(current(h.db, S3), { model: NEXT, effort: 'medium' }, 'slightly older file evidence still names the effort');
  assert.deepEqual(turn(h.db, TB), { ts: T0 + 20_500, model: NEXT, effort: 'medium' }, 'review L5: the earliest start is kept');
  assertPerTurnCost(h.db, S3, h.dir);
});

test('report v1: model, effort and turn_id on turn.start; a switch without effort shows none', async () => {
  const h = await hookStore();
  const { registration } = addRegistration(h.dir, { agent: 'claude', profileKey: 'p1' });
  let now = T0 + 1000;
  const reports = createReportIntake({ db: h.db, writer: h.writer, dataDir: h.dir, now: () => now });
  const S4 = S('0004'), RA = S('1004'), RB = S('2004');
  let seq = 0;
  const frame = (o: Record<string, unknown>) => ({ v: 1, delivery_id: `d-${++seq}`, session_id: S4, producer_id: 'fixture-producer', producer_seq: seq,
    event: 'turn.start', source_ts: iso(0), payload: {}, ...o });
  assert.equal((await reports.deliver(registration, frame({ turn_id: RA, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, effort: 'high' }))).status, 'accepted');
  assert.deepEqual(current(h.db, S4), { model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(turn(h.db, RA), { ts: T0 + 1000, model: 'claude-opus-5-5', effort: 'high' });
  now = T0 + 5000;
  await reports.deliver(registration, frame({ turn_id: RB, model: { id: 'claude-sonnet-5-5' } }));
  assert.deepEqual(current(h.db, S4), { model: 'claude-sonnet-5-5', effort: null });
  assert.deepEqual(markers(h.db, S4), [[T0 + 1000, 'Claude Opus 5.5 · high'], [T0 + 5000, 'Claude Sonnet 5.5']]);
});

// XAIBO-PROD-442 (G4b-2, FR-51): a report frame with a lower producer_seq arriving after a newer one is delayed evidence:
// it never reverts the session's current model or effort, but its own turn keeps its model.
test('XAIBO-PROD-442: reversed report delivery keeps the newer model current; the older turn keeps its own model', async () => {
  const h = await hookStore();
  const { registration } = addRegistration(h.dir, { agent: 'claude', profileKey: 'p1' });
  let now = T0 + 1000;
  const reports = createReportIntake({ db: h.db, writer: h.writer, dataDir: h.dir, now: () => now });
  const S5 = S('0005'), RA = S('1005'), RB = S('2005');
  const frame = (seq: number, o: Record<string, unknown>) => ({ v: 1, delivery_id: `r-${seq}`, session_id: S5, producer_id: 'fixture-producer', producer_seq: seq,
    event: 'turn.start', source_ts: iso(0), payload: {}, ...o });
  assert.equal((await reports.deliver(registration, frame(2, { turn_id: RB, model: { id: 'claude-sonnet-5-5' } }))).status, 'accepted');
  now = T0 + 5000;
  assert.equal((await reports.deliver(registration, frame(1, { turn_id: RA, model: { id: 'claude-opus-5-5' }, effort: 'high' }))).status, 'accepted');
  assert.deepEqual(current(h.db, S5), { model: 'claude-sonnet-5-5', effort: null }, 'the delayed frame does not revert the current model');
  assert.deepEqual({ model: (turn(h.db, RA) as { model: string }).model, effort: (turn(h.db, RA) as { effort: string }).effort }, { model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual({ model: (turn(h.db, RB) as { model: string }).model }, { model: 'claude-sonnet-5-5' });
  // in-order evidence still switches
  now = T0 + 9000;
  await reports.deliver(registration, frame(3, { turn_id: S('3005'), model: { id: 'claude-opus-5-5' }, effort: 'low' }));
  assert.deepEqual(current(h.db, S5), { model: 'claude-opus-5-5', effort: 'low' });
  // review M1: the newest-seq read is one index lookup, not a walk of the registration's deliveries
  const plan = h.db.prepare(`EXPLAIN QUERY PLAN ${NEWEST_SEQ}`).all(registration.id, 'fixture-producer', S5).map((r) => String((r as { detail: string }).detail)).join(' ');
  assert.match(plan, /report_delivery_seq/);
  // review L2: a delayed frame after a newer one without a model still fills an unknown model (never replaces one)
  const S6 = S('0006');
  await reports.deliver(registration, { ...frame(5, { event: 'tool.start', item_id: 'i1' }), session_id: S6, delivery_id: 'r6-5' });
  await reports.deliver(registration, { ...frame(4, { turn_id: S('1006'), model: { id: 'claude-sonnet-5-5' } }), session_id: S6, delivery_id: 'r6-4' });
  assert.deepEqual(current(h.db, S6), { model: 'claude-sonnet-5-5', effort: null });
});

// XAIBO-PROD-453 (G4b-2 follow-up): only model-bearing deliveries make model evidence stale. A newer frame without a model
// says nothing about the model, so a delayed frame that is still the newest model evidence becomes current.
test('XAIBO-PROD-453: a delayed model frame newer than every stored model frame wins over a newer frame without a model', async () => {
  const h = await hookStore();
  const { registration } = addRegistration(h.dir, { agent: 'claude', profileKey: 'p1' });
  let now = T0 + 1000;
  const reports = createReportIntake({ db: h.db, writer: h.writer, dataDir: h.dir, now: () => now });
  const S7 = S('0007');
  const frame = (seq: number, o: Record<string, unknown>) => ({ v: 1, delivery_id: `m-${seq}`, session_id: S7, producer_id: 'fixture-producer', producer_seq: seq,
    event: 'turn.start', source_ts: iso(0), payload: {}, ...o });
  await reports.deliver(registration, frame(1, { turn_id: S('1007'), model: { id: 'claude-opus-5-5' } }));
  now = T0 + 2000;
  await reports.deliver(registration, frame(3, { event: 'tool.start', item_id: 'i1' }));
  now = T0 + 3000;
  await reports.deliver(registration, frame(2, { turn_id: S('2007'), model: { id: 'claude-sonnet-5-5' } }));
  assert.deepEqual(current(h.db, S7), { model: 'claude-sonnet-5-5', effort: null });
  // the model-seq read stays one index lookup (review M1)
  const plan = h.db.prepare(`EXPLAIN QUERY PLAN ${NEWEST_SEQ}`).all(registration.id, 'fixture-producer', S7).map((r) => String((r as { detail: string }).detail)).join(' ');
  assert.match(plan, /USING (COVERING )?INDEX report_delivery_seq/);
});

test('XAIBO-PROD-453: migration 013 marks stored model-bearing report deliveries', async () => {
  const h = await hookStore();
  const { registration } = addRegistration(h.dir, { agent: 'claude', profileKey: 'p1' });
  const reports = createReportIntake({ db: h.db, writer: h.writer, dataDir: h.dir, now: () => T0 + 1000 });
  const S8 = S('0008');
  const frame = (seq: number, o: Record<string, unknown>) => ({ v: 1, delivery_id: `b-${seq}`, session_id: S8, producer_id: 'fixture-producer', producer_seq: seq,
    event: 'turn.start', source_ts: iso(0), payload: {}, ...o });
  await reports.deliver(registration, frame(1, { turn_id: S('1008'), model: { id: 'claude-opus-5-5' } }));
  await reports.deliver(registration, frame(2, { event: 'tool.start', item_id: 'i1' }));
  // review L1: another source's raw that is not JSON (an oversized record's raw chunk) never fails the backfill
  h.db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, source_seq, received_ts, raw)
    VALUES (?, 1, 'claude', 'confirmed', 'U1#r000001', 'raw-chunk', 1, ?, '{"type":"user","mess')`).run(sid(h.db, S8), T0);
  // back to the 012 shape, then run 013 as the store upgrade does
  h.db.exec(`DROP INDEX report_delivery_seq; ALTER TABLE report_delivery DROP COLUMN has_model;
    CREATE INDEX report_delivery_seq ON report_delivery (registration_id, producer_id, native_session_id, producer_seq)`);
  h.db.exec(loadMigrations().find((m) => m.version === 13)!.sql);
  assert.deepEqual(h.db.prepare('SELECT delivery_id AS id, has_model AS m FROM report_delivery ORDER BY delivery_id').all().map((r) => ({ ...r })),
    [{ id: 'b-1', m: 1 }, { id: 'b-2', m: 0 }]);
});

test('statusLine tee: model.id and effort.level at the service clock replace older evidence', async () => {
  let now = T0 + 1000;
  const h = await hookStore({ intake: { now: () => now } });
  const S5 = S('0005');
  const tee = (record: Record<string, unknown>) => h.intake.deliver(envelope({ event: 'statusline', cwd: null, session_id: S5, payload: { session_id: S5, ...record } }));
  assert.equal((await tee({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, effort: { level: 'high' } })).status, 'accepted');
  assert.deepEqual(current(h.db, S5), { model: 'claude-opus-5-5', effort: 'high' });
  now = T0 + 2000;
  await tee({ model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' } });
  assert.deepEqual(current(h.db, S5), { model: 'claude-sonnet-5-5', effort: null });
  assert.equal(label(h.db, 'claude', 'p1', S5), 'Claude Sonnet 5.5');
});
