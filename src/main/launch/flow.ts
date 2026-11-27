// XAIBO-PROD-623 (P7-T04 slice D; design §6.7, EC-76, EC-84, EC-85; OQ-P7-1): main's launch flow behind the renderer's launch
// asks. Options come from the service's launch info: an agent without a template, or not detected, stays listed with its
// reason; only the default profile launches (the Terminal script passes no profile directory: a profile root reaches an agent
// only through its environment, which the launch never carries). A preview builds the exact command here (P7-T02), with a
// pre-allocated UUID where the template has {id}; the renderer shows the quoted tokens and never assembles a command. Launch
// takes the preview once (it expires), re-reads the launch info (any change is refused), asks for a launch grant or its renewal
// in a native warning dialog (Cancel first and default; a click within CLICK_MS of opening counts as Cancel; the executable
// path, a short hash, the bound interpreter, the template, the fixed environment and the not-a-sandbox sentence), then opens
// Terminal (terminal.ts revalidates the grant immediately before) and registers the provisional row with the service, started
// or failed. One launch at a time. No Electron import (index.ts wires it).
import { realpathSync } from 'node:fs';
import { SANDBOX, q } from '../grants.ts';
import type { LaunchAgentInfo, LaunchOptionsReply, LaunchPreviewReply, LaunchReply, ProvisionalRow, ResumeOptionsReply, ResumeTarget, VsCodeReply } from '../../shared/ipc.ts';
import { BASE_ENV, buildCommand, quote } from './command.ts';
import { fingerprint, grantLaunch, revalidate, type Check, type Field, type Fingerprint } from './grants.ts';
import { launchInTerminal, type Spawner } from './terminal.ts';
import { allowedExternal, openInVsCode } from './vscode.ts';

export interface LaunchDialog { type: 'warning'; title: string; message: string; detail: string; buttons: [string, string]; defaultId: 0; cancelId: 0; noLink: true }
export interface LaunchFlowDeps {
  dataDir: string;
  /** The service's launch info; null when it did not answer. */
  info(): Promise<LaunchAgentInfo[] | null>;
  uuid(): string;
  /** Wall clock (ms) for the provisional row and the grant. */
  now(): number;
  /** Monotonic clock (ms) for expiry and the click delay. */
  mono(): number;
  /** The native message box; true only for the grant button. */
  confirm(d: LaunchDialog): Promise<boolean>;
  spawner: Spawner;
  register(row: ProvisionalRow): void;
  /** XAIBO-PROD-626: the service's resume target for a stored session; null when it did not answer or the session is gone. */
  target(session: number): Promise<ResumeTarget | null>;
  /** shell.openExternal (SEC1: called only with an allowlisted URL). */
  openExternal(url: string): Promise<void>;
}

export const NOT_DETECTED = 'Not detected';
export const PROFILE_UNSUPPORTED = 'Launch from this profile is not supported yet';
// XAIBO-PROD-624: a profile chosen by a login environment variable launches with that one name passed through (its value is
// read in Terminal, from the same login environment Xaibo detected it in); a manually added profile cannot launch yet.
// 624 security review: only a known profile-directory variable, never one a compromised service names (NODE_OPTIONS, DYLD_*…)
const PROFILE_ENV = new Set(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME']);
const launchable = (p: { default: boolean; envKey: string | null }) => p.default || (p.envKey !== null && PROFILE_ENV.has(p.envKey));
const PREVIEW_MS = 10 * 60_000;
const PREVIEWS_MAX = 8;
const CLICK_MS = 750;
// 623 security review (MEDIUM/LOW): launches at least GAP_MS apart and none within COOLDOWN_MS of a cancelled grant, so a
// compromised renderer can neither flood Terminal nor reopen the grant sheet at once. ponytail: per-launch confirmation stays the
// in-app dialog (design §6.7); a native one per launch is recorded as a residual (D-P7-08).
const GAP_MS = 2_000, COOLDOWN_MS = 5_000;
const HEADLESS = /^(?:-p|--print|exec|--headless)$/;
const CHANGED: Record<Field, string> = { exe: 'the executable path', 'exe-hash': "the executable's contents", entry: 'its interpreter', template: 'the argument template', env: 'the environment keys' };

/** The native grant (or renewal) confirmation; the executable as fingerprinted before the dialog opens. */
export function launchDialog(name: string, agent: string, fp: Fingerprint, args: readonly string[], check: Check, cwd: string, envKeys: readonly string[] = []): LaunchDialog {
  const renew = !check.ok && check.blocked === 'renewal required' ? check.field : null;
  const detail = [
    `Agent: ${q(name)} (${agent})`,
    `Executable: ${q(fp.exeReal)}`,
    `SHA-256: ${fp.exeSha256.slice(0, 12)}…`,
    `Interpreter: ${fp.entry ? q(fp.entry.path) : 'none bound (a native program, or one found through PATH when it runs)'}`,
    `Template: [${args.map(q).join(',')}]`,
    `Environment: ${[...BASE_ENV, ...envKeys].join(', ')} only`,
    `In: ${q(cwd)}`, // 623 security review: the working directory of this launch
    ...(renew ? [`Changed: ${CHANGED[renew]}`] : []),
    '', 'Starts the interactive CLI in Terminal. Xaibo observes the session; Terminal keeps control.', '', SANDBOX,
  ].join('\n');
  return renew
    ? { type: 'warning', title: 'Renew launch grant', message: `This agent's launch changed since you granted it. Allow launching it as shown?\n\n${SANDBOX}`, detail, buttons: ['Cancel', 'Renew grant'], defaultId: 0, cancelId: 0, noLink: true }
    : { type: 'warning', title: 'Grant launch', message: `Allow Xaibo to start this agent in Terminal?\n\n${SANDBOX}`, detail, buttons: ['Cancel', 'Grant launch'], defaultId: 0, cancelId: 0, noLink: true };
}

interface Preview {
  agent: string; profileId: string; cwd: string; nativeId: string | undefined; exe: string; args: string[]; names: string[]; envKeys: string[]; at: number;
  /** XAIBO-PROD-626: the grant this kind binds (the agent for Launch, <agent>-resume / <agent>-fork), the provisional row's id
   *  (Launch: the pre-allocated one; Resume: the session's; Fork: none) and the re-read before execution (the agent's entry when
   *  nothing changed). */
  grantKey: string; rowNativeId: string | null; recheck: () => Promise<LaunchAgentInfo | null>;
}
const sameAgent = (a: LaunchAgentInfo | undefined, p: Pick<Preview, 'exe' | 'names' | 'profileId' | 'envKeys'>) => !!a && a.executable === p.exe && a.names.join('\0') === p.names.join('\0')
  && a.profiles.some((x) => x.id === p.profileId && launchable(x) && (x.envKey === null ? [] : [x.envKey]).join('\0') === p.envKeys.join('\0'));
const sameArgs = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

export function launchFlow(d: LaunchFlowDeps) {
  const previews = new Map<string, Preview>();
  let busy = false, lastLaunch = -Infinity, cooldownUntil = -Infinity, lastVsCode = -Infinity;
  const refused = <T>(code: Extract<LaunchReply, { status: 'refused' }>['code']) => ({ status: 'refused', code }) as T;
  const hold = (p: Omit<Preview, 'at'>, argv: string[]): LaunchPreviewReply => {
    const now = d.mono();
    for (const [k, x] of previews) if (now - x.at > PREVIEW_MS) previews.delete(k);
    while (previews.size >= PREVIEWS_MAX) previews.delete(previews.keys().next().value!);
    const previewId = d.uuid();
    previews.set(previewId, { ...p, at: now });
    return { status: 'ok', previewId, command: argv.map(quote).join(' '), cwd: p.cwd, env: [...BASE_ENV, ...p.envKeys] };
  };
  /** The agent and profile a launch of any kind needs: detected, launchable profile, its pass-through variable. */
  const agentFor = (info: LaunchAgentInfo[], agent: string, profileId: string) => {
    const a = info.find((x) => x.agent === agent);
    if (!a) return 'invalid' as const;
    if (a.executable === null) return 'not-detected' as const;
    const prof = a.profiles.find((p) => p.id === profileId);
    if (!prof) return 'invalid' as const;
    if (!launchable(prof)) return 'profile' as const;
    return { a, exe: a.executable, envKeys: prof.default || prof.envKey === null ? [] : [prof.envKey] };
  };
  const reasonText = { invalid: 'This agent is not in the catalog', 'not-detected': NOT_DETECTED, profile: PROFILE_UNSUPPORTED } as const;
  return {
    async options(): Promise<LaunchOptionsReply> {
      const info = await d.info();
      if (!info) return refused('unavailable');
      return { status: 'ok', agents: info.map((a) => ({
        agent: a.agent, name: a.name, version: a.version,
        disabled: 'disabled' in a.launch ? a.launch.disabled : a.executable === null ? NOT_DETECTED : null,
        preallocatedId: 'args' in a.launch && a.launch.preallocatedId,
        profiles: a.profiles.map((p) => ({ id: p.id, label: p.label, disabled: launchable(p) ? null : PROFILE_UNSUPPORTED })),
      })) };
    },
    async preview(ask: { agent: string; profileId: string; cwd: string }): Promise<LaunchPreviewReply> {
      const info = await d.info();
      if (!info) return refused('unavailable');
      const a0 = info.find((x) => x.agent === ask.agent);
      if (a0 && !('args' in a0.launch)) return refused('disabled');
      const f = agentFor(info, ask.agent, ask.profileId);
      if (typeof f === 'string') return refused(f);
      const { a, exe, envKeys } = f;
      if (!('args' in a.launch)) return refused('disabled');
      const args = [...a.launch.args];
      const nativeId = a.launch.preallocatedId ? d.uuid() : undefined;
      const b = buildCommand({ agent: a.agent, executable: exe, args, ...(nativeId ? { nativeId } : {}), cwd: ask.cwd, names: a.names, envKeys });
      if (!b.ok) return refused(b.reason);
      let cwd: string;
      try { cwd = realpathSync.native(ask.cwd); } catch { return refused('cwd'); }
      const names = [...a.names], profileId = ask.profileId;
      return hold({ agent: a.agent, profileId, cwd, nativeId, exe, args, names, envKeys, grantKey: a.agent, rowNativeId: nativeId ?? null,
        recheck: async () => { const x = (await d.info())?.find((y) => y.agent === a.agent); return x && 'args' in x.launch && sameArgs(x.launch.args, args) && sameAgent(x, { exe, names, profileId, envKeys }) ? x : null; } }, b.argv);
    },
    /** XAIBO-PROD-626 (P7-T05, P7-T09): what one stored session offers; each null is available, a string says why not. */
    async resumeOptions(session: number): Promise<ResumeOptionsReply> {
      const [t, info] = await Promise.all([d.target(session), d.info()]);
      if (!t || !info) return refused('unavailable');
      const f = agentFor(info, t.agent, t.profileId);
      const base = typeof f === 'string' ? reasonText[f] : 'disabled' in f.a.launch ? f.a.launch.disabled : t.cwd === null ? 'Original folder unknown; resume disabled' : null;
      const of = (x: ResumeTarget['resume']) => ('disabled' in x ? x.disabled : base);
      return { status: 'ok', resume: of(t.resume), fork: of(t.fork), vscode: t.vscode, liveness: t.liveness };
    },
    /** Resume runs in the session's original folder with the catalog's resume template; Fork with the fork template (FR-21). */
    async resumePreview(session: number, mode: 'resume' | 'fork', confirmed = false): Promise<LaunchPreviewReply> {
      const [t, info] = await Promise.all([d.target(session), d.info()]);
      if (!t || !info) return refused('unavailable');
      const tpl = t[mode];
      // 626 reviews: never headless (checked again here), only agents with a bundled enabled launch template (an imported catalog's
      // resume template never runs), and a resume of a session not proven idle only after the concurrency warning (EC-20)
      if ('disabled' in tpl || tpl.args.some((x) => HEADLESS.test(x))) return refused('disabled');
      if (mode === 'resume' && t.liveness !== 'not-live' && !confirmed) return refused('concurrent');
      const f = agentFor(info, t.agent, t.profileId);
      if (typeof f === 'string') return refused(f);
      if (!('args' in f.a.launch)) return refused('disabled');
      if (t.cwd === null) return refused('cwd');
      const { a, exe, envKeys } = f, args = [...tpl.args], nativeId = t.nativeId;
      const b = buildCommand({ agent: a.agent, executable: exe, args, nativeId, cwd: t.cwd, names: a.names, envKeys });
      if (!b.ok) return refused(b.reason);
      let cwd: string;
      try { cwd = realpathSync.native(t.cwd); } catch { return refused('cwd'); }
      const names = [...a.names], profileId = t.profileId;
      return hold({ agent: a.agent, profileId, cwd, nativeId, exe, args, names, envKeys, grantKey: `${a.agent}-${mode}`, rowNativeId: mode === 'resume' ? nativeId : null,
        recheck: async () => {
          const [t2, i2] = await Promise.all([d.target(session), d.info()]);
          const x = i2?.find((y) => y.agent === a.agent), tpl2 = t2?.[mode];
          return x && t2 && tpl2 && 'args' in tpl2 && sameArgs(tpl2.args, args) && t2.nativeId === nativeId && sameAgent(x, { exe, names, profileId, envKeys }) ? x : null;
        } }, b.argv);
    },
    /** Open in VS Code (FR-22, SEC1): only for a session whose handoff is verified, only the allowlisted URL. */
    async openVsCode(session: number): Promise<VsCodeReply> {
      if (d.mono() - lastVsCode < GAP_MS) return refused('busy'); // 626 security review: spaced like launches
      const t = await d.target(session);
      if (!t) return refused('unavailable');
      if (t.vscode !== null) return refused('disabled');
      const r = await openInVsCode(t.nativeId, async (url) => { if (!allowedExternal(url)) throw new Error('not allowed'); await d.openExternal(url); });
      if (r === 'opened') lastVsCode = d.mono();
      return r === 'opened' ? { status: 'opened' } : r === 'failed' ? { status: 'failed' } : refused('id');
    },
    async launch(previewId: string): Promise<LaunchReply> {
      const t = d.mono();
      if (busy || t - lastLaunch < GAP_MS || t < cooldownUntil) return refused('busy'); // the preview is kept
      const p = previews.get(previewId);
      previews.delete(previewId); // single use
      if (!p || d.mono() - p.at > PREVIEW_MS) return refused('expired');
      busy = true;
      try {
        const a = await p.recheck();
        if (!a) return refused('changed');
        const spec = { exe: p.exe, template: p.args, envKeys: p.envKeys };
        const check = await revalidate(d.dataDir, p.grantKey, spec);
        if (!check.ok) {
          const fp = await fingerprint(p.exe); // taken before the dialog opens: the grant binds what it showed
          if (!fp) return refused('executable');
          const opened = d.mono();
          const yes = await d.confirm(launchDialog(a.name, p.agent, fp, p.args, check, p.cwd, p.envKeys));
          if (!yes || d.mono() - opened < CLICK_MS) { cooldownUntil = d.mono() + COOLDOWN_MS; return { status: 'cancelled' }; }
          try { await grantLaunch(d.dataDir, p.grantKey, spec, 'bundled', fp, d.now()); } catch { return refused('changed'); }
        }
        const r = await launchInTerminal({ agent: p.agent, grantKey: p.grantKey, executable: p.exe, args: p.args, ...(p.nativeId ? { nativeId: p.nativeId } : {}), cwd: p.cwd, names: p.names, envKeys: p.envKeys, dataDir: d.dataDir }, d.spawner, d.now());
        if (r.status === 'blocked') return refused('grant');
        if (r.status === 'refused') return refused(r.reason);
        lastLaunch = d.mono();
        const key = d.uuid();
        const row: ProvisionalRow = { key, agent: p.agent, profileId: p.profileId, cwd: p.cwd, nativeId: p.rowNativeId, startedAt: d.now(),
          state: r.status === 'started' ? 'starting' : 'failed', reason: r.status === 'failed' ? r.reason : null };
        d.register(row);
        return r.status === 'started' ? { status: 'started', key } : { status: 'failed', key, reason: r.reason };
      } finally { busy = false; }
    },
  };
}
