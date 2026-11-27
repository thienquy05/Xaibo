// XAIBO-PROD-569 (P6-T10 unit 1; design §6.6 Startup): the result line of Settings > Startup. It says what the OS has after
// Save, never what was asked for.
import type { StartupReply } from '../../shared/ipc.ts';

/** Code review 1: Save waits for the current value, and a value that could not be read needs an explicit choice first, so
 *  a fast click never silently turns off a login item the owner had on. */
export const canSave = (loaded: boolean | null | 'loading', touched: boolean): boolean => loaded !== 'loading' && (loaded !== null || touched);

export function startupText(r: StartupReply | null): string {
  if (!r) return 'The result is unavailable. Check the setting before trying again.';
  if (r.status === 'ready') return r.enabled ? 'Saved. Xaibo starts at login.' : 'Saved. Xaibo does not start at login.';
  if (r.enabled === null) return 'macOS did not apply the change.';
  return `macOS did not apply the change. Start at login is ${r.enabled ? 'on' : 'off'}.`;
}
