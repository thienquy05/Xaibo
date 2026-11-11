// Crash policy (P1-T13, OQ-P1-10): no crash reporter anywhere (crashReporter is lint-banned); uncaught exceptions and
// unhandled rejections in main and the service become error-code log entries through the content-free logger. A
// message or stack is never recorded. The service exits after an uncaught exception (its supervisor restarts it);
// main keeps running.
import type { Logger } from './log.ts';

export interface ErrorSource { on(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown }

/** The error's code, else its class name, else "unknown"; the logger keeps it only if it is code-shaped. */
export function errorCode(e: unknown): string {
  if (typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string') return (e as { code: string }).code;
  return e instanceof Error ? e.name : 'unknown';
}

export function installCrashPolicy(proc: ErrorSource, log: Logger, o: { exitOnUncaught?: () => void } = {}): void {
  proc.on('uncaughtException', (e) => { log.log('uncaught_exception', { error: errorCode(e) }); o.exitOnUncaught?.(); });
  proc.on('unhandledRejection', (e) => { log.log('unhandled_rejection', { error: errorCode(e) }); });
}
