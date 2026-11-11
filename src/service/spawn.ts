// The one sanctioned child_process module (lint rule, P1-T01). Fixed argv, never a shell, stdin closed, bounded time
// and output. The child gets its own process group, so a timeout or overflow kills its descendants too (a login
// shell's children would otherwise hold the pipe open). Callers get a result, never a throw.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface RunOptions { timeoutMs: number; maxBytes: number; env?: NodeJS.ProcessEnv }
export interface RunResult { code: number | null; stdout: Buffer; timedOut: boolean; overflow: boolean; error: boolean }

export const succeeded = (r: RunResult) => r.code === 0 && !r.timedOut && !r.overflow && !r.error;

export function run(file: string, args: readonly string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess;
    const finish = (code: number | null, error = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), timedOut, overflow, error });
    };
    const killGroup = () => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      child.stdout?.destroy();
      finish(null); // do not wait for 'close': a descendant that left the group could hold the pipe
    };
    try {
      child = spawn(file, args, { shell: false, detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: o.env ?? process.env });
    } catch { return finish(null, true); }
    timer = setTimeout(() => { timedOut = true; killGroup(); }, o.timeoutMs);
    child.stdout!.on('data', (d: Buffer) => {
      size += d.length;
      if (size > o.maxBytes) { overflow = true; killGroup(); } else chunks.push(d);
    });
    child.on('error', () => finish(null, true));
    child.on('close', (code) => finish(code));
  });
}
