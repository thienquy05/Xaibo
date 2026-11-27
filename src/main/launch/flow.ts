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
import type { LaunchAgentInfo, LaunchOptionsReply, LaunchPreviewReply, LaunchReply, ProvisionalRow } from '../../shared/ipc.ts';
import { BASE_ENV, buildCommand, quote } from './command.ts';
import { fingerprint, grantLaunch, revalidate, type Check, type Field, type Fingerprint } from './grants.ts';
import { launchInTerminal, type Spawner } from './terminal.ts';

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

interface Preview { agent: string; profileId: string; cwd: string; nativeId: string | undefined; exe: string; args: string[]; names: string[]; envKeys: string[]; at: number }
const sameLaunch = (a: LaunchAgentInfo | undefined, p: Preview) => !!a && a.executable === p.exe && 'args' in a.launch
  && a.launch.args.length === p.args.length && a.launch.args.every((t, i) => t === p.args[i]) && a.names.join('\0') === p.names.join('\0')
  && a.profiles.some((x) => x.id === p.profileId && launchable(x) && (x.envKey === null ? [] : [x.envKey]).join('\0') === p.envKeys.join('\0'));

export function launchFlow(d: LaunchFlowDeps) {
  const previews = new Map<string, Preview>();
  let busy = false, lastLaunch = -Infinity, cooldownUntil = -Infinity;
  const refused = <T>(code: Extract<LaunchReply, { status: 'refused' }>['code']) => ({ status: 'refused', code }) as T;
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
      const a = info.find((x) => x.agent === ask.agent);
      if (!a) return refused('invalid');
      if (!('args' in a.launch)) return refused('disabled');
      if (a.executable === null) return refused('not-detected');
      const prof = a.profiles.find((p) => p.id === ask.profileId);
      if (!prof) return refused('invalid');
      if (!launchable(prof)) return refused('profile');
      const envKeys = prof.default || prof.envKey === null ? [] : [prof.envKey];
      const nativeId = a.launch.preallocatedId ? d.uuid() : undefined;
      const b = buildCommand({ agent: a.agent, executable: a.executable, args: a.launch.args, ...(nativeId ? { nativeId } : {}), cwd: ask.cwd, names: a.names, envKeys });
      if (!b.ok) return refused(b.reason);
      let cwd: string;
      try { cwd = realpathSync.native(ask.cwd); } catch { return refused('cwd'); }
      const now = d.mono();
      for (const [k, p] of previews) if (now - p.at > PREVIEW_MS) previews.delete(k);
      while (previews.size >= PREVIEWS_MAX) previews.delete(previews.keys().next().value!);
      const previewId = d.uuid();
      previews.set(previewId, { agent: a.agent, profileId: prof.id, cwd, nativeId, exe: a.executable, args: [...a.launch.args], names: [...a.names], envKeys, at: now });
      return { status: 'ok', previewId, command: b.argv.map(quote).join(' '), cwd, env: [...BASE_ENV, ...envKeys] };
    },
    async launch(previewId: string): Promise<LaunchReply> {
      const t = d.mono();
      if (busy || t - lastLaunch < GAP_MS || t < cooldownUntil) return refused('busy'); // the preview is kept
      const p = previews.get(previewId);
      previews.delete(previewId); // single use
      if (!p || d.mono() - p.at > PREVIEW_MS) return refused('expired');
      busy = true;
      try {
        const info = await d.info();
        if (!info) return refused('unavailable');
        const a = info.find((x) => x.agent === p.agent);
        if (!sameLaunch(a, p)) return refused('changed');
        const spec = { exe: p.exe, template: p.args, envKeys: p.envKeys };
        const check = await revalidate(d.dataDir, p.agent, spec);
        if (!check.ok) {
          const fp = await fingerprint(p.exe); // taken before the dialog opens: the grant binds what it showed
          if (!fp) return refused('executable');
          const opened = d.mono();
          const yes = await d.confirm(launchDialog(a!.name, p.agent, fp, p.args, check, p.cwd, p.envKeys));
          if (!yes || d.mono() - opened < CLICK_MS) { cooldownUntil = d.mono() + COOLDOWN_MS; return { status: 'cancelled' }; }
          try { await grantLaunch(d.dataDir, p.agent, spec, 'bundled', fp, d.now()); } catch { return refused('changed'); }
        }
        const r = await launchInTerminal({ agent: p.agent, executable: p.exe, args: p.args, ...(p.nativeId ? { nativeId: p.nativeId } : {}), cwd: p.cwd, names: p.names, envKeys: p.envKeys, dataDir: d.dataDir }, d.spawner, d.now());
        if (r.status === 'blocked') return refused('grant');
        if (r.status === 'refused') return refused(r.reason);
        lastLaunch = d.mono();
        const key = d.uuid();
        const row: ProvisionalRow = { key, agent: p.agent, profileId: p.profileId, cwd: p.cwd, nativeId: p.nativeId ?? null, startedAt: d.now(),
          state: r.status === 'started' ? 'starting' : 'failed', reason: r.status === 'failed' ? r.reason : null };
        d.register(row);
        return r.status === 'started' ? { status: 'started', key } : { status: 'failed', key, reason: r.reason };
      } finally { busy = false; }
    },
  };
}
