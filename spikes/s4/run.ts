// S4 driver (P0-S4-T3..T7): hooks-only Claude plugin in the TEMP profile. Run unsandboxed with the guard and block
// backstop around it. Writes reduced evidence only (names, counts, booleans, schemas) to spikes/s4/evidence/.
// Usage: node spikes/s4/run.ts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const PROFILE = join(homedir(), '.xaibo-spike-profiles', 'claude-a');
const CONFIG = join(PROFILE, 'home', '.claude');
const MARKET = join(PROFILE, 'marketplace'); // stands in for <appdata>/integrations/
const RAW = join(REPO, '.cache', 'spike-results', 's4', 'raw');
const PROJECT = join(REPO, '.cache', 'spike-projects', 's4');
const EVIDENCE = join(REPO, 'spikes', 's4', 'evidence');
const PLUGIN = 'xaibo-hooks-spike@xaibo-spike';
const SETTINGS = join(CONFIG, 'settings.json');
const PROMPTS = {
  ok: ['Reply with the single word OK.'],
  tool: ['Run the shell command `ls` once, then reply DONE.', '--allowedTools', 'Bash(ls)'],
  write: ['Create a file named spike.txt containing the word hi, then reply DONE.'], // not allowed in -p: denied
  sub: ['Use one subagent to list the files in this directory, then reply DONE.', '--allowedTools', 'Task,Agent,Bash(ls),Glob,LS'],
};

const sh = (args: string[], cwd = PROJECT) => spawnSync('/bin/bash', [join(REPO, 'spikes/shared/in-profile.sh'), '--spike', 's4', 'claude', 'a', '--', ...args], { cwd, encoding: 'utf8', timeout: 240_000 });
const claude = (p: string[]) => { const t0 = Date.now(); const r = sh(['claude', '-p', ...p]); return { code: r.status, out: r.stdout.trim(), errBytes: Buffer.byteLength(r.stderr ?? ''), ms: Date.now() - t0 }; };
const cli = (...a: string[]) => { const r = sh(['claude', 'plugin', ...a]); return { code: r.status, out: (r.stdout + r.stderr).trim() }; };
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const recorderLines = (tag = 'claude') => { const f = join(RAW, `${tag}.jsonl`); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const clearRaw = () => { rmSync(RAW, { recursive: true, force: true }); mkdirSync(RAW, { recursive: true }); };
const SKIP = /^(projects|session|todos|statsig|shell-snapshots|backups|debug|telemetry|cache|paste-cache|file-history)/;
const tree = (): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!existsSync(CONFIG)) return out;
  for (const f of readdirSync(CONFIG, { recursive: true }).map(String)) {
    const p = join(CONFIG, f);
    if (SKIP.test(f) || !statSync(p).isFile()) continue;
    out[f] = sha(readFileSync(p));
  }
  return out;
};
const diff = (a: Record<string, string>, b: Record<string, string>) => ({
  added: Object.keys(b).filter((k) => !(k in a)).sort(), removed: Object.keys(a).filter((k) => !(k in b)).sort(),
  modified: Object.keys(b).filter((k) => k in a && a[k] !== b[k]).sort(),
});
const readSettings = () => (existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {});
const writeSettings = (o: object) => writeFileSync(SETTINGS, `${JSON.stringify(o, null, 2)}\n`, { mode: 0o600 });
const transcriptsNow = () => { const root = join(CONFIG, 'projects'); return new Set(existsSync(root) ? readdirSync(root, { recursive: true }).map(String).filter((x) => x.endsWith('.jsonl')).map((x) => join(root, x)) : []); };
const firstUsage = (before: Set<string>) => {
  for (const f of [...transcriptsNow()].filter((x) => !before.has(x))) {
    for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(l);
      const u = r?.message?.usage;
      if (r.type === 'assistant' && u) return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
  }
  return null;
};
const markerSeen = (before: Set<string>, marker: string) => [...transcriptsNow()].filter((f) => !before.has(f)).some((f) => readFileSync(f, 'utf8').includes(marker));
const count = (tag: string) => recorderLines(tag).reduce((a: Record<string, number>, l) => ({ ...a, [l.event]: (a[l.event] ?? 0) + 1 }), {});

mkdirSync(PROJECT, { recursive: true });
if (!existsSync(join(PROJECT, 'README.txt'))) writeFileSync(join(PROJECT, 'README.txt'), 'synthetic\n');
mkdirSync(EVIDENCE, { recursive: true });
rmSync(MARKET, { recursive: true, force: true });
cpSync(join(REPO, 'spikes/s4/marketplace'), MARKET, { recursive: true });
const ev: Record<string, unknown> = {};
const originalSettings = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : null;
try {
  // T5(d) seeds before install: a synthetic agent-flow-style foreign hook and a custom statusLine.
  const FOREIGN = { matcher: '*', hooks: [{ type: 'command', command: 'true # synthetic-foreign-hook' }] };
  const STATUS = { type: 'command', command: 'echo synthetic-status' };
  writeSettings({ ...readSettings(), hooks: { PostToolUse: [FOREIGN] }, statusLine: STATUS });
  const seedSpan = () => { const s = readSettings(); return sha(JSON.stringify([s.hooks?.PostToolUse, s.statusLine])); };
  const seedHash = seedSpan();

  // T3: RED baseline, install, file delta, receipt
  clearRaw();
  claude(PROMPTS.ok);
  ev.recorderBeforeInstall = recorderLines().length;
  const t0 = tree();
  const add = cli('marketplace', 'add', MARKET);
  let inst = cli('install', PLUGIN, '-s', 'user');
  const firstInstallExit = inst.code;
  if (inst.code !== 0) inst = cli('install', PLUGIN, '-s', 'user', '-y');
  const t1 = tree();
  ev.install = { marketplaceAddExit: add.code, installExit: firstInstallExit, retriedWithYes: firstInstallExit !== 0, retryExit: firstInstallExit !== 0 ? inst.code : null, delta: diff(t0, t1) };
  clearRaw();
  const runs = Object.fromEntries(Object.entries(PROMPTS).map(([k, p]) => [k, claude(p)]));
  const lines = recorderLines();
  ev.receipt = {
    replies: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { exit: r.code, stderrBytes: r.errBytes }])),
    events: [...new Set(lines.map((l) => l.event))].sort(), perEvent: count('claude'),
  };
  writeFileSync(join(RAW, 'for-reduce.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  spawnSync(process.execPath, [join(REPO, 'spikes/shared/reduce.ts'), '--in', join(RAW, 'for-reduce.jsonl'), '--out', join(EVIDENCE, 'hooks'), '--schema'], { encoding: 'utf8' });

  // T4: zero tokens (first assistant usage, plugin disabled vs enabled) and the stdout-marker leak probe
  cli('disable', PLUGIN);
  let before = transcriptsNow(); claude(PROMPTS.ok); const usageOff = firstUsage(before);
  cli('enable', PLUGIN);
  before = transcriptsNow(); claude(PROMPTS.ok); const usageOn = firstUsage(before);
  const MARKER = `XAIBO-MARKER-${sha(String(process.hrtime.bigint()))}`;
  const s0 = readSettings();
  writeSettings({ ...s0, hooks: { ...s0.hooks, UserPromptSubmit: [{ hooks: [{ type: 'command', command: `echo ${MARKER}` }] }] } });
  before = transcriptsNow(); const mk = claude(PROMPTS.ok); const usageMarker = firstUsage(before);
  ev.m7 = {
    usageDisabled: usageOff, usageEnabled: usageOn, tokenDelta: usageOff !== null && usageOn !== null ? usageOn - usageOff : null,
    markerVariant: { reachedTranscript: markerSeen(before, MARKER), tokenDeltaVsEnabled: usageMarker !== null && usageOn !== null ? usageMarker - usageOn : null, replyClean: mk.out.replace(/[.\s]/g, '') === 'OK' },
  };
  writeSettings(s0);

  // T5: duplicates, policy, coexistence
  const again = cli('install', PLUGIN, '-s', 'user');
  const listedText = sh(['claude', 'plugin', 'list', '--json']).stdout;
  ev.doubleInstall = { exit: again.code, mentions: (listedText.match(/xaibo-hooks-spike@/g) ?? []).length };
  const fallbackHook = (e: string) => [{ hooks: [{ type: 'command', async: true, command: `node '${join(REPO, 'spikes/shared/record-hook.mjs')}' fallback ${e}` }] }];
  const s1 = readSettings();
  writeSettings({ ...s1, hooks: { ...s1.hooks, UserPromptSubmit: fallbackHook('UserPromptSubmit'), SessionEnd: fallbackHook('SessionEnd') } });
  clearRaw(); claude(PROMPTS.ok);
  ev.pluginPlusFallback = { plugin: count('claude'), fallback: count('fallback') };
  writeSettings({ ...s1, disableAllHooks: true });
  clearRaw(); claude(PROMPTS.ok);
  ev.disableAllHooks = { pluginLines: recorderLines().length, detectableInSettings: readSettings().disableAllHooks === true };
  writeSettings(s1);
  const httpVariant = join(MARKET, 'xaibo-hooks-spike-http');
  cpSync(join(MARKET, 'xaibo-hooks-spike'), httpVariant, { recursive: true });
  writeFileSync(join(httpVariant, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://localhost/hook' }] }] } }));
  const v = sh(['claude', 'plugin', 'validate', '--json', httpVariant]);
  ev.pluginHttpHookType = { validateExit: v.status };
  rmSync(httpVariant, { recursive: true, force: true });

  // T6: disconnect; a foreign enabledPlugins entry added while installed must survive
  const s2 = readSettings();
  writeSettings({ ...s2, enabledPlugins: { ...(s2.enabledPlugins ?? {}), 'synthetic-foreign@elsewhere': true } });
  const un = cli('uninstall', PLUGIN, '-s', 'user');
  const rm = cli('marketplace', 'remove', 'xaibo-spike');
  const t2 = tree();
  const after = readSettings();
  clearRaw(); claude(PROMPTS.ok);
  ev.restore = {
    uninstallExit: un.code, marketplaceRemoveExit: rm.code, vsBeforeInstall: diff(t0, t2),
    foreignEnabledPluginSurvives: after.enabledPlugins?.['synthetic-foreign@elsewhere'] === true,
    xaiboEnabledPluginLeft: Object.keys(after.enabledPlugins ?? {}).filter((k) => k.includes('xaibo')),
    seedsUnchanged: seedSpan() === seedHash,
    listedAfter: (sh(['claude', 'plugin', 'list', '--json']).stdout || '').includes('xaibo-hooks-spike'),
    recorderAfterUninstall: recorderLines().length,
  };

  // T7: fallback (marker-based settings merge) tested separately; removal must be byte-identical
  const s3 = readSettings();
  delete s3.enabledPlugins?.['synthetic-foreign@elsewhere'];
  writeSettings(s3);
  const pre = readFileSync(SETTINGS);
  const MARK_DIR = join(PROFILE, 'integrations', 'xaibo', 'bin'); // marker: commands under a xaibo integrations dir
  mkdirSync(MARK_DIR, { recursive: true });
  writeFileSync(join(MARK_DIR, 'xaibo-hook'), `#!/bin/sh\nexec node '${join(REPO, 'spikes/shared/record-hook.mjs')}' claude "$1"\n`, { mode: 0o700 });
  const fb = (e: string) => ({ ...(e === 'PreToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', async: true, command: `'${join(MARK_DIR, 'xaibo-hook')}' ${e}` }] });
  const merged = { ...s3, hooks: { ...s3.hooks } as Record<string, object[]> };
  for (const e of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SessionEnd']) merged.hooks[e] = [...(merged.hooks[e] ?? []), fb(e)];
  writeSettings(merged);
  clearRaw(); claude(PROMPTS.tool);
  const fbEvents = [...new Set(recorderLines().map((l) => l.event))].sort();
  const kept = Object.entries(merged.hooks as Record<string, object[]>).map(([e, arr]): [string, object[]] => [e, arr.filter((h) => !JSON.stringify(h).includes('/integrations/xaibo/bin/'))]);
  const removed = { ...merged, hooks: Object.fromEntries(kept.filter(([, arr]) => arr.length)) };
  writeSettings(removed);
  ev.fallback = { events: fbEvents, byteIdenticalAfterRemoval: Buffer.compare(pre, readFileSync(SETTINGS)) === 0 };
} finally {
  if (originalSettings === null) rmSync(SETTINGS, { force: true }); else writeFileSync(SETTINGS, originalSettings);
  writeFileSync(join(EVIDENCE, 's4.json'), `${JSON.stringify(ev, null, 2)}\n`);
  console.log(JSON.stringify(ev));
}
