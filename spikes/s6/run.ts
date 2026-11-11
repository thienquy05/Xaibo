// S6 driver (P0-S6-T1..T3, plus the Codex /compact leftover of S13-T6): Codex 0.160.0 in the TEMP profile through the
// runner. Run unsandboxed with the guard and block backstop around it (see the bottom of this file's usage):
//   node spikes/s6/run.ts [exec] [tui] [as] [picker] [attach] [daemon]     (no argument = every step; results merge)
// Headless steps use `codex exec` and the app-server probe; TUI steps run in a detached `screen` (spikes/shared/tui.ts).
// One project dir per surface, so the resume picker (filtered by cwd) shows whether a surface's sessions are listed.
// Writes names, booleans and counts only to spikes/s6/evidence/s6.json. 8 tiny prompts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CTRL_C, ENTER, tui, type Tui } from '../shared/tui.ts';

const REPO = join(import.meta.dirname, '..', '..');
const RUNNER = join(REPO, 'spikes/shared/in-profile.sh');
const SESSIONS = join(homedir(), '.xaibo-spike-profiles', 'codex-a', 'home', '.codex', 'sessions');
const LOGS = join(REPO, '.cache', 'spike-results', 's6');
const PROBE = join(import.meta.dirname, 'app-server-probe.ts');
const PR_OK = 'Reply with the single word OK.';
const PR_WRITE = 'Create a file named spike.txt containing the word hi, then reply DONE.';
const PREVIEW = /Reply with the single word/;
const dir = (name: string) => { const p = join(REPO, '.cache', 'spike-projects', 's6', name); mkdirSync(p, { recursive: true }); return p; };
const P = { exec: dir('exec'), tui: dir('tui'), as: dir('as') };
const trust = (cwd: string) => ['-c', `projects."${cwd}".trust_level="trusted"`];
const wrap = (args: string[]) => ['bash', RUNNER, '--spike', 's6', 'codex', 'a', '--', ...args];
const headless = (args: string[], cwd: string) => spawnSync(wrap(args)[0]!, wrap(args).slice(1), { cwd, encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'] });
const cleanup = () => spawnSync(process.execPath, [join(REPO, 'spikes/shared/in-profile.ts'), 'cleanup', 'codex', 'a'], { stdio: 'ignore' });

interface Rollout { file: string; id: string; source: unknown; originator: unknown; metaKeys: string[]; types: string[]; payloadTypes: string[]; turnsDone: number }
function rollouts(): Rollout[] {
  if (!existsSync(SESSIONS)) return [];
  return readdirSync(SESSIONS, { recursive: true }).map(String).filter((f) => /rollout-.*\.jsonl$/.test(f)).map((f) => join(SESSIONS, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).map((file) => {
      const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as { type?: string; payload?: Record<string, unknown> }]; } catch { return []; } });
      const meta = recs.find((r) => r.type === 'session_meta')?.payload ?? {};
      return { file, id: String(meta.id ?? ''), source: meta.source, originator: meta.originator, metaKeys: Object.keys(meta).sort(),
        types: [...new Set(recs.map((r) => String(r.type)))].sort(), payloadTypes: [...new Set(recs.map((r) => String(r.payload?.type ?? '')))].filter(Boolean).sort(),
        turnsDone: recs.filter((r) => r.payload?.type === 'task_complete').length };
    });
}
const byId = (id: string) => rollouts().find((r) => r.id === id);
async function newRollout(known: Set<string>, turns = 1, ms = 150_000): Promise<Rollout | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = rollouts().find((x) => !known.has(x.file) && x.turnsDone >= turns); if (r) return r; await sleep(1000); }
  return rollouts().find((x) => !known.has(x.file));
}
async function turns(id: string, n: number, ms = 150_000) { const end = Date.now() + ms; while (Date.now() < end) { if ((byId(id)?.turnsDone ?? 0) >= n) return true; await sleep(1000); } return false; }
const known = () => new Set(rollouts().map((r) => r.file));
const open = (name: string, cwd: string, args: string[]) => tui(name, cwd, LOGS, wrap(['codex', ...args]));
// A session TUI first shows the hooks review (the temp profile holds changed recorder hooks from S5): continue
// without trusting them. Returns whether the review was shown.
async function session(name: string, cwd: string, args: string[]) {
  const t = open(name, cwd, args);
  const review = await t.waitFor(/Hooks? .{0,12}review/i, 12_000);
  if (review) { t.send('3'); await sleep(800); t.send(ENTER); }
  return { t, review };
}
async function close(t: Tui) { t.send(CTRL_C); await sleep(700); t.send(CTRL_C); await sleep(1500); t.quit(); cleanup(); await sleep(500); }
async function picker(name: string, cwd: string, extra: string[] = []) {
  const t = open(name, cwd, ['resume', '--no-daemon', ...trust(cwd), ...extra]);
  const rendered = await t.waitFor(/Resume a previous session/, 30_000);
  await sleep(6000);
  // TUI sessions get generated names, so the row count ("1 / 3") decides, not the prompt text.
  const count = [...t.text().matchAll(/(\d+) \/ (\d+)/g)].at(-1);
  const listed = count ? Number(count[2]) > 0 : PREVIEW.test(t.text());
  await close(t);
  return rendered ? listed : null; // null = the picker never rendered: no verdict
}

const EVIDENCE = join(import.meta.dirname, 'evidence', 's6.json');
const ev: Record<string, unknown> = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) as Record<string, unknown> : { codex: '0.160.0', profile: 'temp (codex-a), runner, --no-daemon for every TUI', promptsAttempted: 0 };
let prompts = Number(ev.promptsAttempted ?? ev.prompts ?? 0); // counts launches with a prompt, including ones that never reached the model
const steps = process.argv.slice(2);
const want = (x: string) => steps.length === 0 || steps.includes(x);
let k = known();
let t: Tui;

if (want('exec')) {
// T1(b) exec, exec resume
k = known();
const ex = headless(['codex', 'exec', ...trust(P.exec), PR_OK], P.exec); prompts++;
const E = await newRollout(k, 1, 5000);
const exr = E ? headless(['codex', 'exec', 'resume', E.id, PR_OK], P.exec) : null; if (exr) prompts++;
ev.exec = { exit: ex.status, rolloutWritten: !!E, source: E?.source, originator: E?.originator,
  resumeSyntax: 'codex exec resume <id> "<prompt>"', resumeExit: exr?.status ?? null, resumeAppendsSameRollout: E ? (byId(E.id)?.turnsDone ?? 0) >= 2 : null };

}
if (want('tui')) {
// T1(a) TUI, resume, fork (+ /compact for S13-T6)
k = known();
const first = await session('s6tui', P.tui, ['--no-daemon', ...trust(P.tui), PR_OK]); prompts++;
t = first.t;
const T = await newRollout(k);
await close(t);
const tuiEv: Record<string, unknown> = { hooksReviewShownFirst: first.review, rolloutWritten: !!T, turnCompleted: (T?.turnsDone ?? 0) >= 1, source: T?.source, originator: T?.originator };
if (T) {
  t = (await session('s6res', P.tui, ['resume', T.id, '--no-daemon', ...trust(P.tui), PR_OK])).t; prompts++;
  tuiEv.resumeSyntax = 'codex resume <id> ["<prompt>"]';
  tuiEv.resumeContinuesSameRollout = await turns(T.id, 2);
  const before = byId(T.id);
  t.send('/compact'); await sleep(800); t.send(ENTER); prompts++;
  await sleep(45_000);
  const after = byId(T.id);
  ev.compact = { command: '/compact', newRecordTypes: after?.types.filter((x) => !before?.types.includes(x)), newPayloadTypes: after?.payloadTypes.filter((x) => !before?.payloadTypes.includes(x)) };
  await close(t);
  k = known();
  t = (await session('s6fork', P.tui, ['fork', T.id, '--no-daemon', ...trust(P.tui), PR_OK])).t; prompts++;
  const F = await newRollout(k);
  await close(t);
  tuiEv.forkSyntax = 'codex fork <id> ["<prompt>"]';
  tuiEv.forkCreatesNewId = !!F && F.id !== T.id;
  tuiEv.forkMetaKeysNotInOriginal = F?.metaKeys.filter((x) => !T.metaKeys.includes(x));
  tuiEv.forkSource = F?.source;
}
ev.tui = tuiEv;
}
if (want('as')) {
// T2 app-server
const as = headless([process.execPath, PROBE, 'basic'], P.as); prompts++;
let basic: Record<string, unknown> = {};
try { basic = JSON.parse(as.stdout.trim().split('\n').pop() ?? '{}'); } catch { basic = { parseError: true }; }
const A = typeof basic.threadId === 'string' ? byId(basic.threadId) : undefined;
delete basic.threadId;
ev.appServer = { invocation: 'codex app-server (stdio, one JSON object per line)', exit: as.status, ...basic, rolloutWritten: !!A, rolloutSource: A?.source, rolloutOriginator: A?.originator };

}
if (want('picker')) {
// Picker visibility per surface (cwd-filtered picker; null = picker did not render)
ev.picker = {
  tuiSessionListed: await picker('s6p1', P.tui),
  execSessionListed: await picker('s6p2', P.exec),
  execSessionListedWithIncludeNonInteractive: await picker('s6p3', P.exec, ['--include-non-interactive']),
  appServerThreadListed: await picker('s6p4', P.as),
  appServerThreadListedWithIncludeNonInteractive: await picker('s6p5', P.as, ['--include-non-interactive']),
};

}
if (want('attach')) {
// T3 attach to a live TUI thread that waits for an approval. 0.160.0 accepts only on-request | never for -a, so the
// pending approval comes from a file write under a read-only sandbox (PR-WRITE instead of the plan's PR-LONG).
k = known();
t = (await session('s6x', P.tui, ['--no-daemon', '-s', 'read-only', '-a', 'on-request', ...trust(P.tui), PR_WRITE])).t; prompts++;
const promptSeen = await t.waitFor(/(approv|allow|permission)[\s\S]{0,400}(Yes|No)/i, 120_000);
const X = await newRollout(k, 0, 5000);
let attach: Record<string, unknown> = { skipped: 'no live thread' };
if (X) {
  const a = headless([process.execPath, PROBE, 'attach', X.id, '--listen-s', '15'], P.tui);
  try { attach = JSON.parse(a.stdout.trim().split('\n').pop() ?? '{}'); } catch { attach = { parseError: true }; }
  const stillPending = (byId(X.id)?.turnsDone ?? 0) === 0;
  t.send(ENTER);
  attach.tuiStillPendingAfterProbe = stillPending;
  attach.tuiTurnCompletesAfterTuiApproval = await turns(X.id, 1, 90_000);
}
await close(t);
ev.attach = { approvalSetup: '-s read-only -a on-request with PR-WRITE', tuiApprovalPromptSeen: promptSeen, tuiMode: '--no-daemon (own in-process app-server)', probe: 'separate `codex app-server` on the same CODEX_HOME', ...attach };

}
if (want('resume-control')) {
// Positive control for the attach result: thread/resume on a FINISHED TUI thread that no client holds (no prompt).
const done = rollouts().filter((r) => r.source === 'cli' && r.turnsDone >= 1).at(-1);
let ctl: Record<string, unknown> = { skipped: 'no finished TUI thread' };
if (done) {
  const a = headless([process.execPath, PROBE, 'attach', done.id, '--listen-s', '3'], P.tui);
  try { ctl = JSON.parse(a.stdout.trim().split('\n').pop() ?? '{}'); } catch { ctl = { parseError: true }; }
}
ev.resumeControl = { target: 'finished TUI thread, no client holding it', resumeOk: ctl.resumeOk, resumeErrorCode: ctl.resumeErrorCode, loadedAfter: ctl.loadedAfter, statusTypeBefore: ctl.statusType };
}
if (want('daemon')) {
// Shared daemon: can it run under the runner at all?
const ds = headless(['codex', 'app-server', 'daemon', 'start'], P.tui);
const dv = headless(['codex', 'app-server', 'daemon', 'version'], P.tui);
ev.daemon = { startExit: ds.status, versionExit: dv.status, note: 'each runner command is one supervised process group, so a daemon cannot outlive the command that starts it' };
headless(['codex', 'app-server', 'daemon', 'stop'], P.tui);
}
cleanup();

delete ev.prompts;
ev.promptsAttempted = prompts;
mkdirSync(join(import.meta.dirname, 'evidence'), { recursive: true });
writeFileSync(EVIDENCE, `${JSON.stringify(ev, null, 2)}\n`);
console.log(JSON.stringify(ev, null, 2));
