// S3 live temp-profile Claude runs (P0-S3-T8). Run unsandboxed AFTER the benches (timings), with the guard and the
// block backstop around it (see the plan). Hooks are written into the TEMP profile's user settings only and removed
// afterwards. Reports event coverage, reply/transcript cleanliness, coarse turn time and service-down behaviour.
// Usage: node spikes/s3/live.ts
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { reduce } from '../shared/reduce.ts';

const REPO = join(import.meta.dirname, '..', '..');
const APP = join(REPO, 'dist/spike/mac-arm64/XaiboSpike.app');
const PROFILE = join(homedir(), '.xaibo-spike-profiles', 'claude-a');
const CONFIG = join(PROFILE, 'home', '.claude');
const DATA = join(PROFILE, 'xaibo-data');
const PROJECT = join(REPO, '.cache', 'spike-projects', 's3');
const OUT = join(REPO, '.cache', 'spike-results', 's3');
const RUNNER = join(REPO, 'spikes/shared/in-profile.sh');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
const HTTP_EVENTS = EVENTS.filter((e) => e !== 'SessionStart'); // docs: SessionStart supports command/mcp_tool only
const PROMPTS = { ok: 'Reply with the single word OK.', tool: 'Run the shell command `ls` once, then reply DONE.' };

function settingsFor(candidate: string, httpPort = 0, token = ''): object {
  if (candidate === 'none') return {};
  const hooks: Record<string, object[]> = {};
  const command = (e: string) => ({ type: 'command', async: true, command: `XAIBO_FWD_CANDIDATE=${candidate} XAIBO_APP='${APP}' '${join(REPO, 'spikes/s3/shim.sh')}' claude ${e}` });
  const http = () => ({ type: 'http', url: `http://127.0.0.1:${httpPort}/hook`, headers: { 'X-Xaibo-Token': token } });
  for (const e of candidate === 'http' ? HTTP_EVENTS : EVENTS) hooks[e] = [{ ...(['PreToolUse', 'PostToolUse'].includes(e) ? { matcher: '*' } : {}), hooks: [candidate === 'http' ? http() : command(e)] }];
  return { hooks };
}

function launchApp(): { child: ChildProcess; msgs: Record<string, any>[] } {
  const env: NodeJS.ProcessEnv = { ...process.env, XAIBO_DATA_DIR: DATA, XAIBO_SPIKE_MODE: 's3' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(join(APP, 'Contents/MacOS/XaiboSpike'), [], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const msgs: Record<string, any>[] = [];
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) { try { msgs.push(JSON.parse(buf.slice(0, i))); } catch { /* ignore */ } } });
  return { child, msgs };
}

function claude(prompt: string) {
  const args = [RUNNER, '--spike', 's3', 'claude', 'a', '--', 'claude', '-p', prompt, ...(prompt === PROMPTS.tool ? ['--allowedTools', 'Bash(ls)'] : [])];
  const t0 = Date.now();
  const r = spawnSync('/bin/bash', args, { cwd: PROJECT, encoding: 'utf8', timeout: 180_000 });
  return { ms: Date.now() - t0, code: r.status, stdout: r.stdout.trim(), stderrBytes: Buffer.byteLength(r.stderr ?? '') };
}

const transcripts = () => {
  const root = join(CONFIG, 'projects');
  if (!existsSync(root)) return [] as string[];
  return readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl')).map((f) => join(root, f));
};

// Reduced view only: record types/subtypes and any key path mentioning hooks (no content leaves this process).
function transcriptFacts(files: string[]) {
  const records = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return { event: 'record', payload: JSON.parse(l) }; } catch { return null; } }).filter(Boolean)) as Record<string, unknown>[];
  const red = reduce(records).record;
  const types = red?.keys.type?.values ?? [];
  const hookPaths = Object.keys(red?.keys ?? {}).filter((k) => /hook/i.test(k));
  const subtypes = red?.keys.subtype?.values ?? [];
  return { types, subtypes, hookPaths };
}

const spooledCount = () => {
  const s = join(DATA, 'spool');
  return existsSync(s) ? readdirSync(s).filter((f) => f.endsWith('.jsonl')).reduce((a, f) => a + readFileSync(join(s, f), 'utf8').split('\n').filter(Boolean).length, 0) : 0;
};

mkdirSync(PROJECT, { recursive: true });
if (!existsSync(join(PROJECT, 'README.txt'))) writeFileSync(join(PROJECT, 'README.txt'), 'synthetic\n');
mkdirSync(OUT, { recursive: true });
const settingsFile = join(CONFIG, 'settings.json');
const original = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null;
const report: Record<string, unknown> = {};
try {
  for (const candidate of ['none', 'electron-node', 'sea', 'http']) {
    rmSync(join(DATA, 'spool'), { recursive: true, force: true });
    const app = launchApp();
    while (!app.msgs.some((m) => 's3-ready' in m)) await sleep(50);
    const token = readFileSync(join(DATA, 'run', 'token'), 'utf8');
    const port = JSON.parse(readFileSync(join(DATA, 'run', 'http.json'), 'utf8')).port as number;
    writeFileSync(settingsFile, JSON.stringify(settingsFor(candidate, port, token), null, 2), { mode: 0o600 });
    const before = new Set(transcripts());
    const runs = [claude(PROMPTS.ok), claude(PROMPTS.tool)];
    await sleep(1500); // async hooks may land after the turn
    const events = [...new Set(app.msgs.filter((m) => m['s3-hop']).map((m) => m['s3-hop'].event as string))].sort();
    const facts = transcriptFacts(transcripts().filter((f) => !before.has(f)));
    app.child.kill('SIGTERM');
    await sleep(500);
    report[candidate] = {
      replies: runs.map((r) => ({ ok: r.code === 0, replyIsExpected: ['OK', 'DONE'].includes(r.stdout.replace(/[.\s]/g, '')), stderrBytes: r.stderrBytes, ms: r.ms })),
      events, missing: (candidate === 'none' ? [] : candidate === 'http' ? HTTP_EVENTS : EVENTS).filter((e) => !events.includes(e)),
      transcript: facts,
    };
    console.log(`${candidate}: events ${events.join(',') || '-'}; replies ${runs.map((r) => r.stdout.slice(0, 8)).join('/')}; ms ${runs.map((r) => r.ms).join('/')}`);
  }
  // Service down: hooks installed, app not running. Expect no agent-visible noise; A/B spool; replay on next start.
  for (const candidate of ['sea', 'http']) {
    rmSync(join(DATA, 'spool'), { recursive: true, force: true });
    const token = readFileSync(join(DATA, 'run', 'token'), 'utf8');
    writeFileSync(settingsFile, JSON.stringify(settingsFor(candidate, 1, token), null, 2), { mode: 0o600 }); // port 1: refused
    const run = claude(PROMPTS.ok);
    const spooled = spooledCount();
    const app = launchApp();
    while (!app.msgs.some((m) => 's3-ready' in m)) await sleep(50);
    const replayed = app.msgs.find((m) => 's3-ready' in m)?.['s3-ready'].replayed ?? 0;
    app.child.kill('SIGTERM');
    await sleep(500);
    report[`down-${candidate}`] = { ok: run.code === 0, replyIsExpected: run.stdout.replace(/[.\s]/g, '') === 'OK', stderrBytes: run.stderrBytes, ms: run.ms, spooled, replayed };
    console.log(`service down (${candidate}): reply ${run.stdout.slice(0, 8)} stderr ${run.stderrBytes} B; spooled ${spooled}, replayed ${replayed}`);
  }
} finally {
  if (original === null) rmSync(settingsFile, { force: true }); else writeFileSync(settingsFile, original);
  writeFileSync(join(OUT, 'live.json'), JSON.stringify(report, null, 2));
}
