// P4-T12b (EC-100) additions to the live-load run (`--usage`), synthetic only: Claude statusLine frames through the
// packaged tee (context, rate limits, cost, model, effort; every 10th malformed), each paired with the original command
// run alone on the same stdin so the tee's own cost is measured apart from the foreign statusLine runtime (M16) and its
// output compared byte for byte (M7); Codex token_count lines with rate limits (some malformed); and the data dir on a
// sparse disk image that the run fills to ENOSPC and frees again (disk-full fault, EC-44 under load). Binds sockets and
// mounts an image: run outside the command sandbox.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { teeCommand } from '../../src/forwarder/statusline-tee.ts';
import { now } from './emitter.ts';

export const ORIGINAL = "printf 'synthetic status %s' ok"; // the owner's statusLine command the tee wraps
export const FRAME_MS = 1000; // per Claude session (Claude redraws on each message, at most every 300 ms)
export const MALFORMED_EVERY = 10;

/** A statusLine stdin frame; cost grows each time, so every frame differs and is stored (store-on-change). */
export function frame(sid: string, k: number): string {
  return JSON.stringify({
    session_id: sid, model: { id: 'claude-opus-5-5', display_name: 'Synthetic Opus' }, effort: { level: k % 50 < 25 ? 'high' : 'medium' },
    cost: { total_cost_usd: Math.round(k * 1000) / 100000 },
    context_window: { context_window_size: 200_000, used_percentage: k % 100, remaining_percentage: 100 - (k % 100), total_input_tokens: k * 100,
      total_output_tokens: k * 20, current_usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: k } },
    rate_limits: { five_hour: { used_percentage: k % 100, resets_at: 1767225600 }, seven_day: { used_percentage: 20, resets_at: 1767830400 } },
  });
}

/** Malformed frames: cut JSON, not an object, and an object of wrong types. Only the last carries a usable session id;
 *  the allowlist keeps nothing else of it, so it stores a snapshot with no values (`keepsSession`). */
export function malformed(sid: string, k: number): { stdin: string; keepsSession: boolean } {
  switch (k % 3) {
    case 0: return { stdin: `{"session_id":"${sid}","cost":{"total_cost_usd":`, keepsSession: false };
    case 1: return { stdin: '[1,2,3]', keepsSession: false };
    default: return { stdin: JSON.stringify({ session_id: sid, model: { id: 7 }, cost: { total_cost_usd: -1 }, context_window: 'x', rate_limits: [1] }), keepsSession: true };
  }
}

/** The claude-tee manifest entry Connect would write, naming ORIGINAL; returns the statusLine command Claude runs. */
export function installTee(dataDir: string, profile: string): string {
  const command = teeCommand(dataDir, profile);
  writeFileSync(path.join(dataDir, 'integrations', 'manifest.json'), JSON.stringify({ v: 1, entries: [{ route: 'claude-tee', state: 'applied',
    owned: [{ pointer: '/statusLine/command', value: command, old: ORIGINAL }] }] }), { mode: 0o600 });
  return command;
}

export interface Timed { t0: bigint; ms: number; out: Buffer; err: Buffer; code: number | null }
/** Spawns `file` with `stdin`; wall time and the bytes it wrote (G4f-3: the bytes themselves, not only their count). */
export function timed(file: string, args: string[], stdin: string): Promise<Timed> {
  return new Promise((resolve, reject) => {
    const t0 = now();
    // review M6: a hung command is killed, so a loop always ends and cleanup runs
    const c = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' }, timeout: 30_000 });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    c.stdout.on('data', (d: Buffer) => { out.push(d); });
    c.stderr.on('data', (d: Buffer) => { err.push(d); });
    c.stdin.on('error', () => undefined);
    c.on('error', reject);
    c.on('close', (code) => resolve({ t0, ms: Number(now() - t0) / 1e6, out: Buffer.concat(out), err: Buffer.concat(err), code }));
    c.stdin.end(stdin);
  });
}

/** M7 / FR-45 per frame: the tee's stdout is byte for byte the original's, it writes no stderr and mirrors the exit code. */
export const teeMatches = (tee: Pick<Timed, 'out' | 'err' | 'code'>, original: Pick<Timed, 'out' | 'code'>) =>
  tee.out.equals(original.out) && tee.err.length === 0 && tee.code === original.code;
export const sh = (command: string, stdin: string) => timed('/bin/sh', ['-c', command], stdin);

/** A Codex token_count record (cumulative totals, last request, rate limits), or a malformed one of valid JSON (wrong
 *  types: still a stored record, no usable reading). */
export function codexTokenCount(total: number, k: number, bad: boolean): string {
  const ts = new Date().toISOString();
  if (bad) return `${JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: 'x', rate_limits: { primary: { used_percent: -5, window_minutes: 'x', resets_at: 'soon' }, secondary: 7 } } })}\n`;
  const usage = (n: number) => ({ input_tokens: n, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: Math.floor(n / 5), reasoning_output_tokens: 0, total_tokens: n + Math.floor(n / 5) });
  return `${JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(total), last_token_usage: usage(100), model_context_window: 200_000 },
    rate_limits: { limit_name: null, primary: { used_percent: k % 100, window_minutes: 300, resets_at: 1767243600 }, secondary: { used_percent: 38, window_minutes: 10080, resets_at: 1767830400 } } } })}\n`;
}

/** A sparse HFS+ image of `gib` GiB mounted at `<root>/vol`; the undo detaches it, then removes the image (G4f-1: a
 *  failed detach throws and leaves the image, so the printed `hdiutil detach -force` recovery still has its file). */
export function volume(root: string, gib: number): { mount: string; detach: () => void } {
  const img = path.join(root, 'vol.sparseimage');
  const mount = path.join(root, 'vol');
  execFileSync('/usr/bin/hdiutil', ['create', '-size', `${gib}g`, '-type', 'SPARSE', '-fs', 'HFS+', '-volname', 'xaibo-perf', img], { stdio: 'ignore' });
  mkdirSync(mount);
  execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, img], { stdio: 'ignore' });
  return { mount, detach: () => { execFileSync('/usr/bin/hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' }); rmSync(img, { force: true }); } };
}

/** Fills the volume holding `file` to the byte in shrinking chunks (as m16.ts `full`, large chunks first); true when full. */
export function fillVolume(file: string): boolean {
  const fd = openSync(file, 'a');
  try {
    for (const size of [16 << 20, 1 << 20, 64 << 10, 4096, 512, 1]) {
      const b = Buffer.alloc(size);
      try { for (;;) writeSync(fd, b); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOSPC') return false; }
    }
    return true;
  } finally { closeSync(fd); }
}
