// Main process (P1-T04): private data dir, single instance, locked-down window, tray, the service process.
// Close hides the window and collection continues; Quit stops the service, then exits. The service is supervised
// (P1-T06): restarted with backoff, a fresh port brokered to the renderer after every start and every page load.
import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, powerMonitor, utilityProcess } from 'electron';
import type { MessagePortMain, Tray } from 'electron';
import { appendFileSync } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';
import { installCrashPolicy } from '../shared/crash.ts';
import { AGENT_ID, IPC_VERSION } from '../shared/ipc.ts';
import { createLogger, loadInstallSecret } from '../shared/log.ts';
import { initDataDir } from './app-paths.ts';
import { buildBundle, readLogTail, writeBundle } from './diagnostics.ts';
import { APP_ORIGIN, devOrigin } from './policy.ts';
import { lockDown, registerAppScheme, webPreferences } from './security.ts';
import { Supervisor } from './service-supervisor.ts';
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
  installCrashPolicy(process, log); // P1-T13: error codes only; main keeps running
  const dev = devOrigin(process.env, app.isPackaged);
  let win: BrowserWindow | null = null;
  let tray: Tray | null = null; // held so it is not garbage-collected
  let quitting = false;
  let stopped = false;
  let blocked = 0;

  const show = () => { win?.show(); win?.focus(); };
  let pageReady = false; // a port sent to a loading page is lost; did-finish-load sends one
  const sendPort = () => {
    if (!win || !pageReady) return;
    const port = supervisor.connect();
    if (port) win.webContents.postMessage('port', null, [port]);
  };
  const supervisor = new Supervisor<MessagePortMain>({
    fork: () => utilityProcess.fork(path.join(here, '..', 'service', 'index.js'), [], {
      serviceName: 'xaibo-service', env: { ...process.env, XAIBO_DATA_DIR: dataDir },
    }),
    channel: () => new MessageChannelMain(),
    onHealth: (h) => win?.webContents.send('health', h),
    onSpawn: sendPort,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    now: Date.now,
    quitMs: SERVICE_QUIT_MS,
    log: (event, fields) => log.log(event, fields),
  });

  app.on('second-instance', show);
  app.on('activate', show);
  app.on('window-all-closed', () => { /* tray app: keep running */ });
  app.on('before-quit', (e) => {
    if (stopped) return;
    e.preventDefault();
    if (quitting) return;
    quitting = true;
    void supervisor.stop().then(() => { stopped = true; app.quit(); });
  });
  process.on('SIGTERM', () => app.quit());
  // "Save diagnostics…" (P1-T13): sanitized bundle, 0600, to the file the user picks.
  const saveDiagnostics = async () => {
    const opts = { title: 'Save diagnostics', defaultPath: 'xaibo-diagnostics.json' };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return;
    writeBundle(r.filePath, buildBundle({
      app: { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      os: { platform: process.platform, release: release(), arch: process.arch },
      health: supervisor.health,
      counters: { requestsBlocked: blocked, ipcDropped: supervisor.dropped },
      logTail: readLogTail(app.getPath('logs'), { lines: 200, bytes: 256 * 1024 }),
    }));
    log.log('diagnostics_saved');
  };
  // Perf trace (P3-T10, XAIBO_PERF_TRACE=1 only): the renderer acks a painted delta id; stamped first, so the time is an
  // upper bound that includes this one IPC hop. Only from our window, only a positive integer, IDs only.
  const trace = process.env.XAIBO_PERF_TRACE === '1' ? path.join(app.getPath('logs'), 'perf-trace-main.jsonl') : null;
  ipcMain.on('paint-ack', (e, delta: unknown) => {
    const t = process.hrtime.bigint();
    if (!trace || !win || e.sender !== win.webContents || !Number.isSafeInteger(delta) || (delta as number) <= 0) return;
    appendFileSync(trace, `${JSON.stringify({ ev: 'paint', delta, t: t.toString() })}\n`);
  });
  // "Set path…" (P1-T08/T12): only from our window, only an agent id; the user picks the file, the service validates it.
  ipcMain.on('set-agent-path', (e, agent: unknown) => {
    if (!win || e.sender !== win.webContents || typeof agent !== 'string' || !AGENT_ID.test(agent)) return;
    void dialog.showOpenDialog(win, { title: 'Choose the agent executable', properties: ['openFile'] }).then((r) => {
      const file = r.filePaths[0];
      if (!r.canceled && file) supervisor.send({ v: IPC_VERSION, type: 'setPath', agent, path: file });
    });
  });

  void app.whenReady().then(() => {
    lockDown(path.join(here, '..', '..', 'dist', 'renderer'), dev, (count) => { blocked = count; log.log('request_blocked', { count }); });
    const save = () => void saveDiagnostics().catch(() => log.log('diagnostics_failed'));
    tray = createTray({ show, saveDiagnostics: save, quit: () => app.quit() });
    Menu.setApplicationMenu(Menu.buildFromTemplate([ // no View menu: no reload or devtools items
      { role: 'appMenu' },
      { label: 'File', submenu: [{ id: 'save-diagnostics', label: 'Save Diagnostics…', click: save }, { type: 'separator' }, { role: 'close' }] },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
    win = new BrowserWindow({ width: 960, height: 640, show: false, title: 'Xaibo', webPreferences: webPreferences(path.join(here, 'preload.cjs')) });
    win.once('ready-to-show', show);
    win.on('close', (e) => { if (!quitting) { e.preventDefault(); win?.hide(); } });
    win.webContents.on('did-start-loading', () => { pageReady = false; });
    win.webContents.on('did-finish-load', () => { pageReady = true; win?.webContents.send('health', supervisor.health); sendPort(); });
    void win.loadURL(dev ? `${dev}/` : `${APP_ORIGIN}/index.html`);
    powerMonitor.on('resume', () => supervisor.send({ v: IPC_VERSION, type: 'wake' }));
    supervisor.start();
    log.log('app_ready', { packaged: app.isPackaged, trayReady: tray !== null });
  });
}
