// P2/SEC1 policy wired into Electron (P1-T04): the app: scheme serves dist/renderer with the CSP header, every other
// request is cancelled and counted, permissions always denied, navigation, window.open and webviews blocked, spellcheck
// off. No crash reporter, auto-updater or shell.openExternal anywhere. S10: no Chromium switches needed.
import { app, protocol, session } from 'electron';
import type { WebPreferences } from 'electron';
import { readFile } from 'node:fs/promises';
import { contentType, CSP, isAllowedRequest, resolveAppFile } from './policy.ts';

/** Must run before `ready`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
}

export const webPreferences = (preload: string): WebPreferences => ({
  preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false,
});

/** After `ready`. `onBlocked` gets the running count of cancelled requests. */
export function lockDown(rendererRoot: string, dev: string | undefined, onBlocked: (count: number) => void): void {
  protocol.handle('app', async (req) => {
    const file = resolveAppFile(rendererRoot, req.url);
    if (!file) return new Response(null, { status: 404 });
    try {
      const body = new Uint8Array(await readFile(file));
      return new Response(body, { headers: { 'content-type': contentType(file), 'content-security-policy': CSP } });
    } catch { return new Response(null, { status: 404 }); }
  });

  const ses = session.defaultSession;
  ses.setSpellCheckerEnabled(false);
  let blocked = 0;
  ses.webRequest.onBeforeRequest((d, cb) => {
    const ok = isAllowedRequest(d.url, dev);
    if (!ok) onBlocked(++blocked);
    cb({ cancel: !ok });
  });
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);

  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}
