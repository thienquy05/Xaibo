// Main process (P1-T04): private data dir, single instance, locked-down window, tray, one service fork.
// Close hides the window and collection continues; Quit stops the service, then exits. T06 adds service restart.
import { app, BrowserWindow, utilityProcess } from 'electron';
import type { Tray, UtilityProcess } from 'electron';
import path from 'node:path';
import { createLogger, loadInstallSecret } from '../shared/log.ts';
import { initDataDir } from './app-paths.ts';
import { APP_ORIGIN, devOrigin } from './policy.ts';
import { lockDown, registerAppScheme, webPreferences } from './security.ts';
import { createTray } from './tray.ts';

const SERVICE_QUIT_MS = 2_000;
const here = import.meta.dirname;

const dataDir = initDataDir({ env: process.env, packaged: app.isPackaged, appData: app.getPath('appData') }, (s) => process.stderr.write(s));
if (dataDir === null) app.exit(1);
else {
  app.setPath('userData', dataDir);
  app.setPath('sessionData', dataDir);
  app.setPath('logs', path.join(dataDir, 'logs'));
  registerAppScheme();
  if (!app.requestSingleInstanceLock()) app.exit(0); // second instance; the first gets 'second-instance'
  else start(dataDir);
}

function start(dataDir: string) {
  const log = createLogger({ dir: app.getPath('logs'), secret: loadInstallSecret(dataDir) });
  const dev = devOrigin(process.env, app.isPackaged);
  let win: BrowserWindow | null = null;
  let tray: Tray | null = null; // held so it is not garbage-collected
  let service: UtilityProcess | null = null;
  let quitting = false;

  const show = () => { win?.show(); win?.focus(); };

  function startService() {
    service = utilityProcess.fork(path.join(here, '..', 'service', 'index.js'), [], { serviceName: 'xaibo-service' });
    service.on('message', (m: { type?: unknown }) => { if (m?.type === 'ready') log.log('service_ready'); });
    service.on('exit', (code) => { log.log('service_exit', { code }); service = null; });
  }

  app.on('second-instance', show);
  app.on('activate', show);
  app.on('window-all-closed', () => { /* tray app: keep running */ });
  app.on('before-quit', (e) => {
    quitting = true;
    const s = service;
    if (!s) return;
    e.preventDefault();
    service = null;
    const timer = setTimeout(() => s.kill(), SERVICE_QUIT_MS);
    s.once('exit', () => { clearTimeout(timer); app.quit(); });
    s.postMessage({ type: 'quit' });
  });
  process.on('SIGTERM', () => app.quit());

  void app.whenReady().then(() => {
    lockDown(path.join(here, '..', '..', 'dist', 'renderer'), dev, (count) => log.log('request_blocked', { count }));
    tray = createTray({ show, quit: () => app.quit() });
    win = new BrowserWindow({ width: 960, height: 640, show: false, title: 'Xaibo', webPreferences: webPreferences(path.join(here, 'preload.cjs')) });
    win.once('ready-to-show', show);
    win.on('close', (e) => { if (!quitting) { e.preventDefault(); win?.hide(); } });
    void win.loadURL(dev ? `${dev}/` : `${APP_ORIGIN}/index.html`);
    startService();
    log.log('app_ready', { packaged: app.isPackaged, trayReady: tray !== null });
  });
}
