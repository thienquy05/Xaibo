// Replay baselines (P3-T07, PRD §6.6): B1 files-only inference and B2 agent-flow-style hook rules, both behind the replay
// engine contract, plus the per-fixture canonical lifecycle false-positive/false-negative count reported next to Xaibo
// (§6.7: Xaibo <= B1, B2). It scores lifecycle only; confidence, reason and findings have their own exact assertions.
//
// FP/FN are counted per expected step of the canonical replay. A "positive" is a lifecycle that tells the user the agent
// stopped or needs them: idle, waiting-for-permission, needs-input, error, ended. A step whose predicted lifecycle differs
// from the expected one counts one FP when the prediction is positive and one FN when the expectation is positive (a wrong
// positive counts both; busy or unknown versus the expected busy or unknown counts neither).
import type { Confidence, EngineFactory, Expect, Fixture, Lifecycle, Observation, ReplayResult, SessionStatus, StatusEngine } from './replay-harness.ts';

const HEURISTIC_MS = 5000;
interface S { lifecycle: Lifecycle; confidence: Confidence; pendingSince: number | null; pending: Set<string> }

function base(on: (o: Observation, s: (id: string) => S, now: number) => void, nowOf: () => number): StatusEngine {
  const sessions = new Map<string, S>();
  const get = (id: string) => {
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = { lifecycle: 'unknown', confidence: 'inferred', pendingSince: null, pending: new Set() }));
    return s;
  };
  const tick = (now: number) => {
    for (const s of sessions.values()) {
      if (s.lifecycle === 'busy' && s.pendingSince !== null && now - s.pendingSince > HEURISTIC_MS) {
        s.lifecycle = 'waiting-for-permission'; s.confidence = 'heuristic';
      }
    }
  };
  return {
    ingest: (o) => on(o, get, nowOf()),
    advance: tick,
    suspend: () => {}, resume: () => {},
    status: (_agent, _profile, id): SessionStatus | null => {
      const s = sessions.get(id);
      return s ? { lifecycle: s.lifecycle, confidence: s.confidence, health: 'connected', reason: null, settleAt: null, outcome: null, findings: [],
        toolCalls: 0, turns: 0, usage: null, model: null, effort: null } : null;
    },
    close: () => {},
  };
}

const set = (s: S, lifecycle: Lifecycle, confidence: Confidence) => { s.lifecycle = lifecycle; s.confidence = confidence; };
const startTool = (s: S, id: string, now: number) => { s.pending.add(id); s.pendingSince ??= now; };
const endTool = (s: S, id: string) => { s.pending.delete(id); if (!s.pending.size) s.pendingSince = null; };
const parse = (line: string): Record<string, unknown> | null => { try { return JSON.parse(line); } catch { return null; } };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** B1: native files only. A prompt or tool activity is busy; an end of turn is idle; a tool pending > 5 s is a heuristic wait. */
export const b1: EngineFactory = (o) => base((obs, get, now) => {
  if (obs.source !== 'file') return;
  const r = parse(obs.line);
  if (!r) return;
  const s = get(obs.sessionId);
  const p = obj(r['payload']);
  const m = obj(r['message']);
  const blocks = Array.isArray(m['content']) ? (m['content'] as unknown[]).map(obj) : [];
  if (obs.agent === 'claude') {
    if (r['type'] === 'user') {
      set(s, 'busy', 'inferred');
      for (const b of blocks) if (b['type'] === 'tool_result') endTool(s, String(b['tool_use_id']));
    } else if (r['type'] === 'assistant') {
      set(s, 'busy', 'inferred');
      for (const b of blocks) if (b['type'] === 'tool_use') startTool(s, String(b['id']), now);
      if (m['stop_reason'] === 'end_turn') set(s, 'idle', 'inferred');
    }
  } else if (obs.agent === 'codex') {
    if (r['type'] === 'event_msg' && p['type'] === 'task_started') set(s, 'busy', 'inferred');
    if (r['type'] === 'event_msg' && p['type'] === 'task_complete') set(s, 'idle', 'inferred');
    if (r['type'] === 'response_item' && /(^|_)call$/.test(String(p['type']))) { set(s, 'busy', 'inferred'); startTool(s, String(p['call_id']), now); }
    if (r['type'] === 'response_item' && /call_output$/.test(String(p['type']))) endTool(s, String(p['call_id']));
  } else if (obs.agent === 'agy') {
    if (r['type'] === 'USER_INPUT') set(s, 'busy', 'inferred');
    if (r['type'] === 'PLANNER_RESPONSE') {
      const calls = Array.isArray(r['tool_calls']) ? r['tool_calls'] : [];
      set(s, calls.length ? 'busy' : 'idle', 'inferred');
    }
  }
}, o.now);

const B2_EVENTS: Record<string, Lifecycle> = {
  SessionStart: 'idle', UserPromptSubmit: 'busy', PreToolUse: 'busy', PostToolUse: 'busy', PostToolUseFailure: 'busy',
  SubagentStart: 'busy', PreInvocation: 'busy', ElicitationResult: 'busy', PermissionRequest: 'waiting-for-permission',
  Notification: 'needs-input', Elicitation: 'needs-input', Stop: 'idle', PostInvocation: 'idle', Interrupt: 'idle',
  StopFailure: 'error', SessionEnd: 'ended',
  'session.start': 'idle', 'turn.start': 'busy', 'tool.start': 'busy', 'tool.end': 'busy', 'turn.end': 'idle', 'turn.error': 'error',
  'permission.request': 'waiting-for-permission', 'input.request': 'needs-input', 'permission.resolve': 'busy', 'input.resolve': 'busy',
  'session.end': 'ended',
};

/** B2: agent-flow-style hook rules. Stop = idle, a PreToolUse without its PostToolUse for 5 s = waiting, no background awareness. */
export const b2: EngineFactory = (o) => base((obs, get, now) => {
  if (obs.source !== 'hook' && obs.source !== 'report') return;
  const e = obs.envelope;
  if (e.session_id === null) return;
  const s = get(e.session_id);
  const p = e.payload ?? {};
  const tool = String(p['tool_use_id'] ?? obj(p['toolCall'])['id'] ?? p['item_id'] ?? '');
  const next = B2_EVENTS[e.event];
  if (next) set(s, next, 'confirmed');
  if (e.event === 'PreToolUse' || e.event === 'tool.start') startTool(s, tool, now);
  if (e.event === 'PostToolUse' || e.event === 'PostToolUseFailure' || e.event === 'tool.end') endTool(s, tool);
  if (next && next !== 'busy') { s.pending.clear(); s.pendingSince = null; }
}, o.now);

const POSITIVE: ReadonlySet<Lifecycle> = new Set(['idle', 'waiting-for-permission', 'needs-input', 'error', 'ended']);

export function score(fx: Fixture, res: ReplayResult): { fp: number; fn: number } {
  let fp = 0, fn = 0;
  fx.steps.forEach((step, i) => {
    const e = (step as { expect?: Expect }).expect;
    if (!e) return;
    const pred = res.perStep.get(i)?.lifecycle ?? 'unknown';
    if (pred === e.lifecycle) return;
    if (POSITIVE.has(pred)) fp++;
    if (POSITIVE.has(e.lifecycle)) fn++;
  });
  return { fp, fn };
}
