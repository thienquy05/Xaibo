// XAIBO-PROD-569 (P6-T10 unit 1; design §6.6 Startup, OQ-P1-16; review R9): Start at login, off by default. Reading never
// registers anything and boot never calls this; Save sets the login item, then reads it back, so a value the OS did not
// apply (an unsigned build, a refused approval) is reported as a failure with what the OS has. No Electron import here: main
// injects app.getLoginItemSettings/setLoginItemSettings, or the E2E file stub (XAIBO_LOGIN_ITEM_STUB=1).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseStartupRequest, type StartupReply } from '../shared/ipc.ts';

export interface LoginItems { get(): boolean; set(on: boolean): void }

export function answerStartup(request: unknown, items: LoginItems): StartupReply {
  const req = parseStartupRequest(request);
  if (!req) return { status: 'failed', code: 'invalid', enabled: null };
  const read = () => { try { return items.get(); } catch { return null; } };
  if (req.op === 'read') { const on = read(); return on === null ? { status: 'failed', code: 'platform', enabled: null } : { status: 'ready', enabled: on }; }
  try { items.set(req.enabled); } catch { /* the read-back below says what the OS has */ }
  const now = read();
  return now === req.enabled ? { status: 'ready', enabled: now } : { status: 'failed', code: 'platform', enabled: now };
}

/** E2E only: the value lives in a file under the app's logs, never the machine's login items. */
export const stubLoginItems = (file: string): LoginItems => ({
  get: () => { try { return (JSON.parse(readFileSync(file, 'utf8')) as { openAtLogin?: unknown }).openAtLogin === true; } catch { return false; } },
  set: (on) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ openAtLogin: on })); },
});
