// P0-S6-T2/T3 app-server probe (stdlib JSON-RPC over stdio, one JSON object per line). Runs INSIDE the temp-profile
// runner, so `codex` and CODEX_HOME are the temp ones. Prints one JSON line of facts; the driver keeps only names,
// booleans and counts. Never calls account/* methods (no quota or usage requests). Server requests are recorded and
// left unanswered.
//   app-server-probe.ts basic
//   app-server-probe.ts attach <threadId> [--proxy] [--listen-s 25]
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const PR_OK = 'Reply with the single word OK.';
const [mode, ...rest] = process.argv.slice(2);
const proxy = rest.includes('--proxy');
const listenS = Number(rest[rest.indexOf('--listen-s') + 1]) || 25;
type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code?: number } };

const child = spawn('codex', proxy ? ['app-server', 'proxy'] : ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
const pending = new Map<number, (m: Msg) => void>();
const notifications = new Set<string>();
const serverRequests = new Set<string>();
let nextId = 1;
let exited = false;
child.on('exit', () => { exited = true; for (const res of pending.values()) res({ error: { code: 0 } }); });
child.on('error', () => { exited = true; });
createInterface({ input: child.stdout }).on('line', (line) => {
  let m: Msg;
  try { m = JSON.parse(line) as Msg; } catch { return; }
  if (m.id !== undefined && !m.method) { pending.get(m.id)?.(m); pending.delete(m.id); }
  else if (m.id !== undefined && m.method) serverRequests.add(m.method);
  else if (m.method) notifications.add(m.method);
});
const call = (method: string, params: unknown, ms = 30_000) => new Promise<Msg>((res) => {
  const id = nextId++;
  pending.set(id, res);
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  setTimeout(() => { if (pending.delete(id)) res({ error: { code: -1 } }); }, ms);
});
const ok = (m: Msg) => m.result !== undefined;
// error code only, never the message text
const ids = (m: Msg) => ((m.result?.data as unknown[] | undefined) ?? []).map((t) => (typeof t === 'string' ? t : String((t as { id?: string }).id)));
const until = async (method: string, ms: number) => { const end = Date.now() + ms; while (Date.now() < end && !notifications.has(method) && !exited) await sleep(200); return notifications.has(method); };

const out: Record<string, unknown> = { mode, proxy };
const init = await call('initialize', { clientInfo: { name: 'xaibo-spike', title: 'Xaibo spike', version: '0.0.0' } });
out.initializeOk = ok(init);
child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);

if (mode === 'basic') {
  const bogus = await call('thread/bogus', {});
  out.wrongMethodIsError = bogus.error !== undefined && bogus.error.code !== -1;
  const start = await call('thread/start', { cwd: process.cwd() });
  const thread = start.result?.thread as { id?: string; source?: unknown } | undefined;
  out.threadStarted = typeof thread?.id === 'string';
  out.threadId = thread?.id;
  out.source = thread?.source;
  const turn = await call('turn/start', { threadId: thread?.id, input: [{ type: 'text', text: PR_OK }] });
  out.turnStarted = ok(turn);
  out.turnCompleted = await until('turn/completed', 120_000);
  out.listedByDefault = ids(await call('thread/list', {})).includes(String(thread?.id));
  const kinds: Record<string, boolean> = {};
  for (const k of ['cli', 'exec', 'appServer']) kinds[k] = ids(await call('thread/list', { sourceKinds: [k] })).includes(String(thread?.id));
  out.listedBySourceKind = kinds;
  out.loadedListed = ids(await call('thread/loaded/list', {})).includes(String(thread?.id));
  const read = await call('thread/read', { threadId: thread?.id, includeTurns: true });
  out.readOk = ok(read);
  out.readTurns = ((read.result?.thread as { turns?: unknown[] } | undefined)?.turns ?? []).length;
} else if (mode === 'attach') {
  const threadId = rest[0];
  out.loadedBefore = ids(await call('thread/loaded/list', {})).includes(String(threadId));
  out.listed = ids(await call('thread/list', {})).includes(String(threadId));
  const read = await call('thread/read', { threadId, includeTurns: true });
  out.readOk = ok(read);
  out.statusType = (read.result?.thread as { status?: { type?: string } } | undefined)?.status?.type;
  const resume = await call('thread/resume', { threadId });
  out.resumeOk = ok(resume);
  out.resumeErrorCode = resume.error?.code ?? null; // -1 = this probe's own 30 s timeout
  out.resumeStatusType = (resume.result?.thread as { status?: { type?: string } } | undefined)?.status?.type;
  const before = new Set(notifications);
  await sleep(listenS * 1000);
  out.notificationsWhileListening = [...notifications].filter((n) => !before.has(n)).sort();
  out.loadedAfter = ids(await call('thread/loaded/list', {})).includes(String(threadId));
} else { out.error = 'usage: basic | attach <threadId> [--proxy] [--listen-s n]'; }

out.notifications = [...notifications].sort();
out.serverRequests = [...serverRequests].sort();
out.serverExitedEarly = exited;
process.stdout.write(`${JSON.stringify(out)}\n`);
child.kill();
process.exit(0);
