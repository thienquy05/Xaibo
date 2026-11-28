// XAIBO-PROD-616 (P7-T04 slice A; OQ-P7-1: Terminal.app via a private .command file): the external-terminal launcher. Right
// before a launch the grant is revalidated (P7-T03) and the command built (P7-T02); argv[0] must be the realpath the grant
// bound (only a race can differ: revalidate already catches a retargeted link). A blocked or refused launch writes and opens
// nothing. A started launch writes the script (0700, O_EXCL, a UUID name, no shell metacharacters) into <dataDir>/launch/run
// (0700, never a link), with a first line that removes that literal path as soon as the shell starts reading it, and opens it
// through the injected spawner (tests never open Terminal). Every I/O error is a result (failed, with a reason), never a
// rejection, and leaves no partial script. Scripts older than five minutes are swept on each launch and at app start
// (sweepLaunchScripts). "started" means Terminal accepted the file, not that the agent runs: the provisional row says so.
// The renderer's launch dialog (design §6.7) and the provisional row come in later slices, after the owner's mock review.
// ponytail: same-user code could swap the executable between revalidation and Terminal running the file (no MAC); stated in
// the threat model, as in grants.ts.
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { privateDir, writeExclusive } from '../../service/fs-private.ts';
import { run, succeeded } from '../../service/spawn.ts';
import { buildCommand, quote, type LaunchCommand, type Refusal } from './command.ts';
import { revalidate, type Field } from './grants.ts';

export interface Spawner { open(file: string): Promise<boolean> }
/** grantKey (XAIBO-PROD-626): the grant this launch kind binds (the agent for Launch; <agent>-resume / <agent>-fork). */
export interface LaunchRequest extends LaunchCommand { dataDir: string; grantKey?: string }
export type LaunchResult = { status: 'started'; argv: string[] } | { status: 'blocked'; blocked: 'grant required' }
  | { status: 'blocked'; blocked: 'renewal required'; field: Field } | { status: 'refused'; reason: Refusal } | { status: 'failed'; reason: 'write' | 'open' };

const SCRIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.command$/;
const STALE_MS = 5 * 60_000;
const SHEBANG = '#!/bin/sh\n';
const runDir = (dataDir: string) => path.join(dataDir, 'launch', 'run');

/** Production: Apple's Terminal (by bundle id) opens the file; fixed argv, no shell; a cold start on a loaded Mac gets 30 s. */
export const terminalSpawner: Spawner = {
  open: async (file) => succeeded(await run('/usr/bin/open', ['-b', 'com.apple.Terminal', file], { timeoutMs: 30_000, maxBytes: 4096, env: { PATH: '/usr/bin:/bin' } })),
};

/** Removes launch scripts nothing ran within five minutes (regular files with our names only; links never followed). */
export function sweepLaunchScripts(dataDir: string, now = Date.now()) {
  let names: string[];
  try { names = readdirSync(runDir(dataDir)); } catch { return; }
  for (const name of names) {
    if (!SCRIPT.test(name)) continue;
    const f = path.join(runDir(dataDir), name);
    try { const st = lstatSync(f); if (st.isFile() && now - st.mtimeMs > STALE_MS) unlinkSync(f); } catch { /* gone already */ }
  }
}

export async function launchInTerminal(r: LaunchRequest, spawner: Spawner, now = Date.now()): Promise<LaunchResult> {
  const check = await revalidate(r.dataDir, r.grantKey ?? r.agent, { exe: r.executable, template: r.args, envKeys: r.envKeys });
  if (!check.ok) return check.blocked === 'grant required' ? { status: 'blocked', blocked: 'grant required' } : { status: 'blocked', blocked: 'renewal required', field: check.field };
  const b = buildCommand(r);
  if (!b.ok) return { status: 'refused', reason: b.reason };
  if (b.argv[0] !== check.exeReal) return { status: 'blocked', blocked: 'renewal required', field: 'exe' }; // not what was granted
  if (!path.isAbsolute(r.dataDir) || !b.script.startsWith(SHEBANG)) return { status: 'failed', reason: 'write' };
  const file = path.join(runDir(r.dataDir), `${randomUUID()}.command`);
  let created = false;
  try {
    privateDir(path.dirname(runDir(r.dataDir)));
    privateDir(runDir(r.dataDir)); // a link or a foreign folder throws
    sweepLaunchScripts(r.dataDir, now);
    created = true; // from here a partial file may exist
    writeExclusive(file, `${SHEBANG}rm -f -- ${quote(file)}\n${b.script.slice(SHEBANG.length)}`, 0o700);
  } catch {
    if (created) try { unlinkSync(file); } catch { /* never created */ }
    return { status: 'failed', reason: 'write' };
  }
  let opened = false;
  try { opened = await spawner.open(file); } catch { /* not opened */ }
  if (!opened) {
    try { unlinkSync(file); } catch { /* already gone */ }
    return { status: 'failed', reason: 'open' };
  }
  return { status: 'started', argv: b.argv };
}
