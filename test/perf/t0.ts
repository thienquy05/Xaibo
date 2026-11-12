// T0 perf probes (P3-T11 notify; the rest of the tier is P3-T16). notify (EC-59, US-2): hook emission to OS notification
// dispatch on the packaged app, real monotonic clock on both ends (the emitter's and main's process.hrtime), stub mode
// (XAIBO_NOTIFY_STUB=1). One session, 100 sequential permission requests, each resolved before the next.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeProfile, deliver } from '../helpers/hook-socket.ts';
import { close, environment, launch, sleep, stats } from './app.ts';

const EVENTS = 100;
const BUDGET_MS = 2000;
const SID = '00000000-0000-4000-8000-0000000f1112';

async function until<T>(f: () => T | null | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (let v = f(); ; v = f()) {
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await sleep(10);
  }
}

export async function notifyProbe() {
  const claude = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-claude-'));
  mkdirSync(path.join(claude, 'projects'));
  const l = await launch(claude, { env: { XAIBO_NOTIFY_STUB: '1' } });
  try {
    const profile = await until(() => claudeProfile(l.dataDir), 30_000);
    await until(() => existsSync(path.join(l.dataDir, 'run', 'token')), 30_000);
    const stub = path.join(l.dataDir, 'logs', 'notify-stub.jsonl');
    const lines = () => (existsSync(stub) ? readFileSync(stub, 'utf8').trim().split('\n').filter(Boolean) : []);
    const hook = (event: string, payload: Record<string, unknown> = {}) => deliver(l.dataDir, { v: 1, delivery_id: randomUUID(), agent: 'claude',
      profile_key: profile, event, session_id: SID, cwd: '/tmp/xaibo-fixture/perf', received_ts: Date.now(), payload: { hook_event_name: event, session_id: SID, ...payload } });
    await hook('SessionStart', { source: 'startup' });
    await hook('UserPromptSubmit', { prompt: 'p' });
    const ms: number[] = [];
    for (let i = 0; i < EVENTS; i++) {
      await hook('PreToolUse', { tool_name: 'Write', tool_use_id: `t${i}` });
      const t0 = process.hrtime.bigint();
      await hook('PermissionRequest', { tool_name: 'Write' });
      const line = await until(() => lines()[i], 10_000);
      ms.push(Number(BigInt((JSON.parse(line) as { t: string }).t) - t0) / 1e6);
      await hook('PostToolUse', { tool_name: 'Write', tool_use_id: `t${i}` });
    }
    const s = stats(ms);
    const extra = lines().length - EVENTS;
    return { metric: 'notify', events: EVENTS, emitToDispatchMs: s, extraNotifications: extra, budgetMs: BUDGET_MS, pass: s.p95 <= BUDGET_MS && extra === 0,
      env: await environment(l.app) };
  } finally {
    await close(l);
    rmSync(claude, { recursive: true, force: true });
  }
}
