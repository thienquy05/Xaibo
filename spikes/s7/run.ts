// S7 driver (P0-S7-T1..T4, plus the Claude leftovers of S13-T6): Claude Code 2.1.319 in the TEMP profile through the
// runner; TUI steps run in a detached `screen` (spikes/shared/tui.ts). Run unsandboxed, one step at a time, with the
// guard and block backstop around the block:
//   node spikes/s7/run.ts t1|t2|t3 <accept|decline|cancel>|t4|s13      (KEYS='["…"]' sets the keys that answer the t3 dialog)
// Recorder hooks and the statusLine tee are passed with --settings (nothing is written to the profile's settings).
// Each step merges names, booleans and counts into spikes/s7/evidence/s7.json. Synthetic prompts only (plan P0-T07).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CTRL_C, ENTER, ESC, tui, type Tui } from '../shared/tui.ts';

const REPO = join(import.meta.dirname, '..', '..');
const RUNNER = join(REPO, 'spikes/shared/in-profile.sh');
const CONFIG = join(homedir(), '.xaibo-spike-profiles', 'claude-a', 'home', '.claude');
const OUT = join(REPO, '.cache', 'spike-results', 's7');
const RAW = join(OUT, 'raw', 'claude.jsonl');
const EVIDENCE = join(import.meta.dirname, 'evidence', 's7.json');
const PR = {
  ok: 'Reply with the single word OK.',
  write: 'Create a file named spike.txt containing the word hi, then reply DONE.',
  bg: 'Start the shell command `sleep 30` in the background and reply STARTED without waiting for it.',
  sub: 'Use one subagent to list the files in this directory, then reply DONE.',
  elicit: 'Call the tool ask_name from the spike server once, then reply DONE.',
  long: 'Run the shell command `sleep 20`, then reply DONE.',
};
const dir = (name: string) => { const p = join(REPO, '.cache', 'spike-projects', 's7', name); mkdirSync(p, { recursive: true }); return p; };
const synthId = () => `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0')}`; // synthetic prefix, unique per run

// Settings for one invocation: the S4 recorder hooks (all events) with an absolute recorder path, plus the tee.
mkdirSync(join(OUT, 'raw'), { recursive: true });
const sockDir = mkdtempSync(join(tmpdir(), 's7-'));
const SOCK = join(sockDir, 'c.sock');
const CAPTURE = join(OUT, 'statusline-capture.jsonl');
const hooks = readFileSync(join(REPO, 'spikes/s4/marketplace/xaibo-hooks-spike/hooks/hooks.json'), 'utf8')
  .replaceAll('${CLAUDE_PLUGIN_ROOT}/hooks/record-hook.mjs', join(REPO, 'spikes/shared/record-hook.mjs'));
const SETTINGS = join(OUT, 'settings.json');
writeFileSync(SETTINGS, JSON.stringify({ ...JSON.parse(hooks), statusLine: { type: 'command', command: `XAIBO_TEE_SOCKET='${SOCK}' '${process.execPath}' '${join(REPO, 'spikes/s13/tee.ts')}'` } }));
const MCP = join(OUT, 'mcp.json');
writeFileSync(MCP, JSON.stringify({ mcpServers: { spike: { command: process.execPath, args: [join(import.meta.dirname, 'elicit-mcp.ts')] } } }));

const wrap = (args: string[]) => ['bash', RUNNER, '--spike', 's7', 'claude', 'a', '--', 'claude', '--settings', SETTINGS, ...args];
const headless = (args: string[], cwd: string) => spawnSync(wrap(args)[0]!, wrap(args).slice(1), { cwd, encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'] });
const cleanup = () => spawnSync(process.execPath, [join(REPO, 'spikes/shared/in-profile.ts'), 'cleanup', 'claude', 'a'], { stdio: 'ignore' });

type Hook = { event: string; payload: Record<string, unknown> };
const hookLines = (): Hook[] => (existsSync(RAW) ? readFileSync(RAW, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Hook]; } catch { return []; } }) : []);
async function hook(from: number, pred: (h: Hook) => boolean, ms = 150_000): Promise<Hook | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const h = hookLines().slice(from).find(pred); if (h) return h; await sleep(500); }
  return undefined;
}
const names = (from: number) => hookLines().slice(from).map((h) => (h.event === 'Notification' ? `Notification:${String(h.payload.notification_type ?? '')}` : h.event));
const transcripts = () => { const root = join(CONFIG, 'projects'); return existsSync(root) ? readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl') && !f.includes('subagents')) : []; };
const transcript = (id: string) => { const f = transcripts().find((x) => x.endsWith(`${id}.jsonl`)); return f ? readFileSync(join(CONFIG, 'projects', f), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } }) : null; };
const entrypoints = (id: string) => [...new Set((transcript(id) ?? []).map((r) => r.entrypoint).filter((x) => typeof x === 'string'))];

// The user record holding the tool_result for one tool_use_id (anchored: never the whole serialized transcript,
// which also carries the system prompt and tool descriptions).
function toolResult(sid: string, toolUseId: unknown) {
  for (const r of transcript(sid) ?? []) {
    if (r.type !== 'user') continue;
    const content = (r.message as { content?: unknown } | undefined)?.content;
    const hit = Array.isArray(content) ? content.find((c) => (c as { type?: string; tool_use_id?: string }).type === 'tool_result' && (c as { tool_use_id?: string }).tool_use_id === toolUseId) as { is_error?: boolean; content?: unknown } | undefined : undefined;
    if (hit) { const text = JSON.stringify(hit.content ?? ''); return { isError: hit.is_error === true, rejected: /doesn't want to proceed|rejected/i.test(text), interrupted: /interrupted by user/i.test(text), action: /\baction=(accept|decline|cancel|unsupported|error)\b/.exec(text)?.[1] ?? null }; }
  }
  return null;
}

// Opens the TUI; answers the folder-trust dialog if it shows.
// The prompt goes FIRST: --allowedTools and --mcp-config take lists and would swallow a prompt placed after them.
// Every session uses --permission-mode default (the temp profile otherwise starts in auto mode on 2.1.322).
async function open(name: string, cwd: string, args: string[], prompt?: string): Promise<Tui> {
  const t = tui(name, cwd, OUT, wrap([...(prompt ? [prompt] : []), '--permission-mode', 'default', ...args]));
  if (await t.waitFor(/trust/i, 8000)) { t.send(ENTER); await sleep(1000); }
  return t;
}
async function close(t: Tui) { t.send(CTRL_C); await sleep(700); t.send(CTRL_C); await sleep(1500); t.quit(); cleanup(); await sleep(500); }
function merge(step: string, data: unknown) {
  mkdirSync(join(import.meta.dirname, 'evidence'), { recursive: true });
  const all = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) as Record<string, unknown> : { claude: '2.1.319', profile: 'temp (claude-a), runner' };
  all[step] = data;
  writeFileSync(EVIDENCE, `${JSON.stringify(all, null, 2)}\n`);
  console.log(JSON.stringify({ [step]: data }, null, 2));
}

const listener = spawn(process.execPath, [join(REPO, 'spikes/s13/capture-listener.ts'), SOCK, CAPTURE], { stdio: 'ignore' });
await sleep(500);
const step = process.argv[2];
try {
  if (step === 't1') {
    const P = dir('tui'); const PP = dir('print');
    const id = synthId(); let from = hookLines().length; let prompts = 0;
    let t = await open('s7a', P, ['--session-id', id], PR.ok); prompts++;
    const stop1 = await hook(from, (h) => h.event === 'Stop' && h.payload.session_id === id);
    await close(t);
    const before = transcripts().length;
    from = hookLines().length;
    t = await open('s7b', P, ['--resume', id], PR.ok); prompts++;
    const stop2 = await hook(from, (h) => h.event === 'Stop');
    await close(t);
    const resumedSameId = stop2?.payload.session_id === id && transcripts().length === before;
    from = hookLines().length;
    t = await open('s7c', P, ['--resume', id, '--fork-session'], PR.ok); prompts++;
    const stop3 = await hook(from, (h) => h.event === 'Stop');
    await close(t);
    from = hookLines().length;
    const p = headless(['-p', PR.ok], PP); prompts++;
    const pid = String(hookLines().slice(from).find((h) => h.event === 'SessionStart')?.payload.session_id ?? '');
    const pr = pid ? headless(['-p', '--resume', pid, PR.ok], PP) : null; if (pr) prompts++;
    // Picker in the -p project dir: is a -p session offered?
    t = await open('s7d', PP, ['--resume']);
    await sleep(6000);
    const pickerText = t.text();
    await close(t);
    merge('t1', {
      prompts,
      launch: { syntax: 'claude --session-id <uuid> "<prompt>"', turnCompleted: !!stop1, transcriptAtProjectsEncIdJsonl: !!transcript(id), entrypoint: entrypoints(id) },
      resume: { syntax: 'claude --resume <id> ["<prompt>"]', turnCompleted: !!stop2, sameIdAndFile: resumedSameId },
      fork: { syntax: 'claude --resume <id> --fork-session', turnCompleted: !!stop3, newId: !!stop3 && stop3.payload.session_id !== id },
      print: { syntax: 'claude -p "<prompt>"', exit: p.status, entrypoint: pid ? entrypoints(pid) : [], resumeByIdSyntax: 'claude -p --resume <id> "<prompt>"', resumeByIdExit: pr?.status ?? null,
        pickerShowsPrintSession: /Reply with the single word/.test(pickerText), pickerSaysNone: /No conversations|no sessions|No previous/i.test(pickerText) },
      helpLists: ['--bg / --background', 'attach', '--desktop', '--fork-session', '--session-id'],
    });
  } else if (step === 't2') {
    // Manual denial: PR-WRITE in the default permission mode, Esc at the permission dialog.
    const P = dir('deny'); const from = hookLines().length;
    rmSync(join(P, 'spike.txt'), { force: true }); // a file left by an earlier attempt would make fileCreated meaningless
    const t = await open('s7deny', P, [], PR.write);
    const perm = await hook(from, (h) => h.event === 'PermissionRequest' || (h.event === 'Notification' && h.payload.notification_type === 'permission_prompt'), 120_000);
    await sleep(2500);
    t.send(ESC);
    const stop = await hook(from, (h) => h.event === 'Stop', 45_000);
    await sleep(4000);
    const lines = hookLines().slice(from);
    const sid = String(lines.find((h) => h.event === 'SessionStart')?.payload.session_id ?? perm?.payload.session_id ?? '');
    const pre = lines.find((h) => h.event === 'PreToolUse'); const req = lines.find((h) => h.event === 'PermissionRequest');
    await close(t);
    merge('t2', {
      prompts: 1, deniedWith: 'Esc at the permission dialog', orderedEvents: names(from),
      permissionRequestFired: !!req, notificationPermissionPrompt: names(from).includes('Notification:permission_prompt'),
      permissionDeniedFired: names(from).includes('PermissionDenied'), postToolUseFired: names(from).includes('PostToolUse'), postToolUseFailureFired: names(from).includes('PostToolUseFailure'), stopFired: !!stop,
      permissionRequestKeys: Object.keys(req?.payload ?? {}).sort(), preToolUseHasToolUseId: typeof pre?.payload.tool_use_id === 'string', permissionRequestHasToolUseId: typeof req?.payload.tool_use_id === 'string',
      transcript: toolResult(sid, pre?.payload.tool_use_id),
      fileCreated: existsSync(join(P, 'spike.txt')),
    });
  } else if (step === 't3') {
    // Input request through the spike MCP server. KEYS (JSON array of key strings) answers the dialog; default = Esc.
    const action = process.argv[3] ?? 'cancel';
    const keys = process.env.KEYS ? JSON.parse(process.env.KEYS) as string[] : [ESC];
    const P = dir('elicit'); const from = hookLines().length;
    const t = await open(`s7el${action}`, P, ['--mcp-config', MCP, '--allowedTools', 'mcp__spike__ask_name'], PR.elicit);
    const asked = await hook(from, (h) => h.event === 'Elicitation' || (h.event === 'Notification' && /elicit/i.test(String(h.payload.notification_type))), 120_000);
    await sleep(2500);
    const dialog = t.text().replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').slice(-700);
    for (const key of keys) { t.send(key); await sleep(900); }
    const stop = await hook(from, (h) => h.event === 'Stop', 60_000);
    const idle = action === 'idle' || process.env.IDLE === '1' ? await hook(from, (h) => h.event === 'Notification' && h.payload.notification_type === 'idle_prompt', 90_000) : undefined;
    const lines = hookLines().slice(from);
    const result = lines.find((h) => h.event === 'ElicitationResult');
    const sid = String(lines.find((h) => h.event === 'SessionStart')?.payload.session_id ?? '');
    const askPre = lines.find((h) => h.event === 'PreToolUse' && /ask_name/.test(String(h.payload.tool_name ?? '')));
    const relayed = askPre ? toolResult(sid, askPre.payload.tool_use_id)?.action ?? null : null; // the ask_name call's own result
    await close(t);
    console.log(`dialog (local only): ${dialog.replaceAll(homedir(), '~')}`);
    const all = existsSync(EVIDENCE) ? (JSON.parse(readFileSync(EVIDENCE, 'utf8')) as Record<string, Record<string, unknown>>).t3 ?? {} : {};
    merge('t3', { ...all, [action]: {
      prompts: 1, elicitationHookFired: lines.some((h) => h.event === 'Elicitation'), askedSignal: asked ? (asked.event === 'Notification' ? `Notification:${String(asked.payload.notification_type)}` : asked.event) : null,
      orderedEvents: names(from), elicitationKeys: Object.keys(lines.find((h) => h.event === 'Elicitation')?.payload ?? {}).sort(),
      elicitationResultFired: !!result, elicitationResultKeys: Object.keys(result?.payload ?? {}).sort(), elicitationResultAction: typeof result?.payload.action === 'string' ? result.payload.action : null,
      serverSawAction: relayed, stopFired: !!stop, ...(process.env.IDLE === '1' ? { idlePromptAfterIdle: !!idle } : {}),
    } });
  } else if (step === 't4') {
    // Background work after Stop, subagent ordering, interrupt. Three prompts in one TUI session.
    const P = dir('bg'); let from = hookLines().length; const ns = (h?: Hook) => (h ? Number(BigInt((h as unknown as { ts_mono_ns: string }).ts_mono_ns) / 1_000_000n) : 0);
    const t = await open('s7bg', P, ['--allowedTools', 'Bash,Task,Agent,Glob,LS'], PR.bg);
    const stopBg = await hook(from, (h) => h.event === 'Stop', 120_000);
    const sid = String(hookLines().slice(from).find((h) => h.event === 'SessionStart')?.payload.session_id ?? '');
    const recordsAtStop = (transcript(sid) ?? []).length;
    await sleep(45_000); // sleep 30 ends in here
    const after = hookLines().slice(from).filter((h) => ns(h) > ns(stopBg));
    const newRecords = (transcript(sid) ?? []).slice(recordsAtStop).map((r) => [r.type, r.subtype, (r.attachment as { type?: string } | undefined)?.type].filter(Boolean).join(':'));
    if (!stopBg) { merge('t4', { error: 'no Stop for PR-BG within 120 s' }); }
    const bg = { stopFiredWhileSleepRuns: !!stopBg, hookEventsAfterStop: after.map((h) => (h.event === 'Notification' ? `Notification:${String(h.payload.notification_type)}` : h.event)),
      secondsFromStopToLastSignal: after.length ? Math.round((ns(after.at(-1)) - ns(stopBg)) / 100) / 10 : null, transcriptRecordsAfterStop: [...new Set(newRecords)].sort() };
    await sleep(5000);
    from = hookLines().length;
    t.send(PR.sub); await sleep(800); t.send(ENTER);
    const stopSub = await hook(from, (h) => h.event === 'Stop', 180_000);
    await hook(from, (h) => h.event === 'SubagentStop', 60_000); // a backgrounded subagent may finish after Stop
    await sleep(3000);
    const sub = { orderedEvents: names(from).filter((n) => /Subagent|^Stop/.test(n)), stopFired: !!stopSub,
      backgroundedAgentShown: /Backgrounded agent/.test(t.text()) };
    from = hookLines().length;
    t.send(PR.long); await sleep(800); t.send(ENTER);
    const pre = await hook(from, (h) => h.event === 'PreToolUse', 90_000);
    await sleep(3000);
    const atEsc = hookLines().length;
    t.send(ESC);
    await sleep(8000);
    const exitDialog = /Background work is running/.test(t.text());
    const afterEsc = names(atEsc);
    const interrupt = { toolStarted: !!pre, eventsAfterEsc: afterEsc, stopFired: afterEsc.includes('Stop'), stopFailureFired: afterEsc.includes('StopFailure'), postToolUseFailureFired: afterEsc.includes('PostToolUseFailure'),
      toolResult: toolResult(sid, pre?.payload.tool_use_id) };
    t.send(CTRL_C); await sleep(1500);
    const exitDialogOnQuit = /Background work is running|will stop when you exit/.test(t.text());
    await close(t);
    merge('t4', { prompts: 3, background: bg, subagent: sub, interrupt, exitDialogWithBackgroundWork: exitDialog || exitDialogOnQuit });
  } else if (step === 's13') {
    // S13-T6 leftovers: statusLine numbers around /compact, a model switch and an effort switch (numbers stay local).
    const P = dir('ctx'); let from = hookLines().length;
    const cap = () => (existsSync(CAPTURE) ? readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { session_id?: string; model?: { id?: string }; effort?: { level?: string }; context_window?: { context_window_size?: number; current_usage?: Record<string, number> | null } }) : []);
    const used = (c?: ReturnType<typeof cap>[number]) => { const u = c?.context_window?.current_usage; return u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : null; };
    const t = await open('s7ctx', P, [], PR.ok);
    await hook(from, (h) => h.event === 'Stop', 120_000);
    const sid = String(hookLines().slice(from).find((h) => h.event === 'SessionStart')?.payload.session_id ?? '');
    await sleep(4000);
    const last = () => cap().filter((c) => c.session_id === sid).at(-1);
    const before = last();
    const n0 = cap().filter((c) => c.session_id === sid).length;
    from = hookLines().length;
    t.send('/compact'); await sleep(800); t.send(ENTER);
    const post = await hook(from, (h) => h.event === 'PostCompact', 120_000);
    await sleep(6000);
    const afterCompact = last();
    const boundary = (transcript(sid) ?? []).find((r) => r.subtype === 'compact_boundary') as { compactMetadata?: Record<string, unknown> } | undefined;
    const cmp = (a: number | null, b: number | null) => (b === null ? 'null' : a === null ? 'number (was null)' : b < a ? 'lower' : b > a ? 'higher' : 'same');
    const compact = { preCompactFired: names(from).includes('PreCompact'), postCompactFired: !!post, postCompactKeys: Object.keys(post?.payload ?? {}).sort(),
      boundaryRecord: !!boundary, boundaryMetadataKeys: Object.keys(boundary?.compactMetadata ?? {}).sort(), statuslineUpdatesAfterCompact: cap().filter((c) => c.session_id === sid).length > n0,
      currentUsageBefore: used(before) === null ? 'null' : 'number',
      currentUsageAfterCompactVsBefore: cap().filter((c) => c.session_id === sid).length > n0 ? cmp(used(before), used(afterCompact)) : 'no new capture' };
    from = hookLines().length;
    t.send('/effort low'); await sleep(800); t.send(ENTER); await sleep(5000);
    const effortAfter = last()?.effort?.level;
    t.send('/model sonnet'); await sleep(800); t.send(ENTER); await sleep(5000);
    t.send(PR.ok); await sleep(800); t.send(ENTER);
    await hook(from, (h) => h.event === 'Stop', 120_000);
    await sleep(5000);
    const afterModel = last();
    await close(t);
    merge('s13', { prompts: 3, compact,
      effort: { command: '/effort low', levelBefore: before?.effort?.level ?? null, levelAfter: effortAfter ?? null },
      model: { command: '/model sonnet', idChanged: !!before?.model?.id && !!afterModel?.model?.id && before.model.id !== afterModel.model.id,
        windowSizeChanged: before?.context_window?.context_window_size !== afterModel?.context_window?.context_window_size, currentUsageAfterSwitchVsAfterCompact: cmp(used(afterCompact), used(afterModel)) } });
  } else if (step === 'recheck') {
    // Recompute t2.transcript, t4.interrupt and s13.compact from the raw local hook log, captures and temp transcripts.
    const all = hookLines();
    const lastSid = (suffix: string) => String([...all].reverse().find((h) => h.event === 'SessionStart' && String(h.payload.cwd ?? '').endsWith(suffix))?.payload.session_id ?? '');
    const ev = JSON.parse(readFileSync(EVIDENCE, 'utf8')) as Record<string, Record<string, unknown>>;
    const deny = lastSid('/s7/deny');
    const denyPre = all.find((h) => h.event === 'PreToolUse' && h.payload.session_id === deny);
    ev.t2 = { ...ev.t2, transcript: toolResult(deny, denyPre?.payload.tool_use_id), fileCreated: null,
      fileCreatedNote: 'not measurable: spike.txt was left by the invalid auto-mode attempt in the same directory' };
    const bg = lastSid('/s7/bg');
    const i = all.findIndex((h) => h.event === 'PreToolUse' && h.payload.session_id === bg && /sleep 20/.test(JSON.stringify(h.payload.tool_input ?? '')));
    const tail = all.slice(i + 1).filter((h) => h.payload.session_id === bg).map((h) => (h.event === 'Notification' ? `Notification:${String(h.payload.notification_type ?? '')}` : h.event));
    const end = tail.indexOf('SessionEnd');
    const afterTool = end >= 0 ? tail.slice(0, end) : tail;
    ev.t4 = { ...ev.t4, interrupt: { toolStarted: i >= 0, eventsAfterInterruptedPreToolUse: afterTool, stopFired: afterTool.includes('Stop'), stopFailureFired: afterTool.includes('StopFailure'),
      postToolUseFired: afterTool.includes('PostToolUse'), postToolUseFailureFired: afterTool.includes('PostToolUseFailure'), toolResult: i >= 0 ? toolResult(bg, all[i]!.payload.tool_use_id) : null,
      note: 'events after the interrupted call until the session ended, any source (the backgrounded subagent may add its own)' } };
    const elicit = all.filter((h) => h.event === 'SessionStart' && String(h.payload.cwd ?? '').endsWith('/s7/elicit')).map((h) => String(h.payload.session_id));
    const t3 = { ...(ev.t3 ?? {}) } as Record<string, Record<string, unknown>>;
    for (const sid of elicit) {
      const result = all.find((h) => h.event === 'ElicitationResult' && h.payload.session_id === sid);
      const pre = all.find((h) => h.event === 'PreToolUse' && h.payload.session_id === sid && /ask_name/.test(String(h.payload.tool_name ?? '')));
      const action = typeof result?.payload.action === 'string' ? result.payload.action : null;
      if (action && t3[action]) t3[action] = { ...t3[action], serverSawAction: pre ? toolResult(sid, pre.payload.tool_use_id)?.action ?? null : null, serverSawActionAnchored: true };
    }
    ev.t3 = t3;
    const ctx = lastSid('/s7/ctx');
    const caps = (existsSync(CAPTURE) ? readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { session_id?: string; model?: { id?: string }; context_window?: { current_usage?: unknown } }) : []).filter((c) => c.session_id === ctx);
    const seq: string[] = [];
    let model = caps[0]?.model?.id;
    for (const c of caps) { const tag = `${c.model?.id === model ? '' : 'new-model:'}${c.context_window?.current_usage ? 'usage' : 'null'}`; if (seq.at(-1) !== tag) seq.push(tag); model = c.model?.id ?? model; }
    ev.s13 = { ...ev.s13, compact: { ...(ev.s13?.compact as object), statuslineUpdatesAfterCompact: undefined, currentUsageAfterCompactVsBefore: undefined,
      captureSequence: seq, captureSequenceNote: 'statusLine captures of the session in order, runs collapsed: null = current_usage null; a null run between usage runs of the same model follows /compact' } };
    writeFileSync(EVIDENCE, `${JSON.stringify(ev, null, 2)}\n`);
    console.log(JSON.stringify({ t2: ev.t2.transcript, t4: ev.t4.interrupt, s13: (ev.s13 as Record<string, Record<string, unknown>>).compact.captureSequence }, null, 1));
  } else {
    console.log('usage: run.ts t1|t2|t3 <accept|decline|cancel>|t4|s13');
  }
} finally { listener.kill('SIGTERM'); rmSync(sockDir, { recursive: true, force: true }); }
