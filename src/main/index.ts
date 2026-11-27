// Main process (P1-T04): private data dir, single instance, locked-down window, tray, the service process.
// Close hides the window and collection continues; Quit stops the service, then exits. The service is supervised
// (P1-T06): restarted with backoff, a fresh port brokered to the renderer after every start and every page load.
import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, Notification, powerMonitor, shell, utilityProcess } from 'electron';
import type { MessagePortMain, Tray } from 'electron';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';
import { installCrashPolicy } from '../shared/crash.ts';
import { AGENT_ID, IPC_VERSION, parseApplyAsk, parseGrantAsk, parseLaunchAsk, type ApplyOutcome, type GrantOutcome, type LaunchAgentInfo, type LaunchOptionsReply, type LaunchPreviewReply, type LaunchReply, type RevealResult, type ServiceMetrics, type StartupReply } from '../shared/ipc.ts';
import { launchFlow } from './launch/flow.ts';
import { sweepLaunchScripts, terminalSpawner } from './launch/terminal.ts';
import { grantFlow } from './grants.ts';
import { applyFlow } from './apply-confirm.ts';
import { appendQuiet, createLogger, loadInstallSecret } from '../shared/log.ts';
import { initDataDir, serviceEnv, trustedEnv } from './app-paths.ts';
import { buildBundle, foldMetrics, readLogTail, writeBundle } from './diagnostics.ts';
import { notificationText, showNotification } from './notifications.ts';
import { forwardPower } from './power.ts';
import { fromOurWindow, revealOverride } from './reveal.ts';
import { answerStartup, stubLoginItems, type LoginItems } from './startup.ts';
import { APP_ORIGIN, devOrigin } from './policy.ts';
import { lockDown, registerAppScheme, webPreferences } from './security.ts';
import { Supervisor } from './service-supervisor.ts';
import { createTray } from './tray.ts';
import { hideWindow, showWindow } from './window.ts';

const SERVICE_QUIT_MS = 2_000;
const here = import.meta.dirname;

const trusted = trustedEnv(process.env, app.isPackaged); // XAIBO-PROD-611: every env read below goes through it
const dataDir = initDataDir({ env: trusted, packaged: app.isPackaged, appData: app.getPath('appData') }, (s) => process.stderr.write(s));
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
  const dev = devOrigin(trusted, app.isPackaged);
  let win: BrowserWindow | null = null;
  let tray: Tray | null = null; // held so it is not garbage-collected
  let quitting = false;
  let stopped = false;
  let blocked = 0;
  let serviceMetrics: ServiceMetrics | null = null;

  const show = () => showWindow(win);
  let pageReady = false; // a port sent to a loading page is lost; did-finish-load sends one
  const sendPort = () => {
    if (!win || !pageReady) return;
    const port = supervisor.connect();
    if (port) win.webContents.postMessage('port', null, [port]);
  };
  // XAIBO-PROD-597 (P6-T08a slice B; D-P6-20, security review): main owns the grant confirmation (grants.ts). The picker and the
  // message box are sheets on our window and are refused while it does not exist; only the grant button sends the binding.
  const grants = grantFlow({
    pickExecutable: async () => {
      if (!win || win.isDestroyed()) return null;
      const r = await dialog.showOpenDialog(win, { title: 'Choose the agent executable to grant', properties: ['openFile'] });
      return r.canceled ? null : r.filePaths[0] ?? null;
    },
    realpath: (p) => realpathSync.native(p),
    confirm: async (d) => (win && !win.isDestroyed() ? (await dialog.showMessageBox(win, d)).response === 1 : false),
    send: (c) => supervisor.send(c),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    now: () => performance.now(),
  });
  // XAIBO-PROD-600 (P6-T12 slice 2; D-P6-21): main owns the confirmation of a real-profile apply (apply-confirm.ts); the message
  // box is a sheet on our window and refused while it does not exist; only the apply button sends the binding.
  const applies = applyFlow({
    confirm: async (d) => (win && !win.isDestroyed() ? (await dialog.showMessageBox(win, d)).response === 1 : false),
    send: (c) => supervisor.send(c),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    now: () => performance.now(),
  });
  // XAIBO-PROD-623 (P7-T04, design §6.7): main owns the launch (launch/flow.ts): the service supplies the launch info (one reply per
  // request id, 10 s, none after a service restart); the grant dialog is a sheet on our window and refused while it does not exist;
  // the provisional row goes to the service. XAIBO_LAUNCH_STUB=1 (E2E, behind the XAIBO_E2E marker) records the script instead of
  // opening Terminal, then removes it as Terminal's run would.
  const infoWaits = new Map<number, (agents: LaunchAgentInfo[] | null) => void>();
  let infoId = 0;
  const launchStub = trusted.XAIBO_LAUNCH_STUB === '1' ? path.join(app.getPath('logs'), 'launch-stub.jsonl') : null;
  const launches = launchFlow({
    dataDir: dataDir!,
    info: () => new Promise((resolve) => {
      const id = ++infoId;
      const timer = setTimeout(() => { infoWaits.delete(id); resolve(null); }, 10_000);
      infoWaits.set(id, (agents) => { clearTimeout(timer); infoWaits.delete(id); resolve(agents); });
      supervisor.send({ v: IPC_VERSION, type: 'launchInfo', id });
    }),
    uuid: randomUUID, now: Date.now, mono: () => performance.now(),
    confirm: async (d) => (win && !win.isDestroyed() ? (await dialog.showMessageBox(win, d)).response === 1 : false),
    spawner: launchStub ? { open: async (file) => { appendQuiet(launchStub, `${JSON.stringify({ script: readFileSync(file, 'utf8') })}\n`); unlinkSync(file); return true; } } : terminalSpawner,
    register: (row) => supervisor.send({ v: IPC_VERSION, type: 'provisional', row }),
  });
  const notifyStub = trusted.XAIBO_NOTIFY_STUB === '1' ? path.join(app.getPath('logs'), 'notify-stub.jsonl') : null;
  const supervisor = new Supervisor<MessagePortMain>({
    fork: () => utilityProcess.fork(path.join(here, '..', 'service', 'index.js'), [], {
      serviceName: 'xaibo-service', env: serviceEnv(trusted, { dataDir, packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    }),
    channel: () => new MessageChannelMain(),
    onHealth: (h) => win?.webContents.send('health', h),
    onSpawn: () => { serviceMetrics = null; grants.reset(); applies.reset(); for (const w of [...infoWaits.values()]) w(null); sendPort(); }, // a new service process: no stale metrics (review L1), grant or apply flow
    onGrant: (g) => grants.receive(g),
    onApply: (a) => applies.receive(a),
    onLaunchInfo: (l) => infoWaits.get(l.id)?.(l.agents),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    now: Date.now,
    quitMs: SERVICE_QUIT_MS,
    log: (event, fields) => log.log(event, fields),
    // P3-T11 (EC-59): the text is built from agent, label and state only; test mode records it with an hrtime stamp.
    onMetrics: (m) => { serviceMetrics = foldMetrics(serviceMetrics, m.metrics); }, // P4-T10c2: for the diagnostics bundle
    onNotify: (n) => {
      const title = notificationText(n.agent, n.label, n.state);
      if (notifyStub) appendFileSync(notifyStub, `${JSON.stringify({ title, t: process.hrtime.bigint().toString() })}\n`);
      else showNotification(Notification, title, (event, fields) => log.log(event, fields));
    },
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
      serviceMetrics,
      logTail: readLogTail(app.getPath('logs'), { lines: 200, bytes: 256 * 1024 }),
    }));
    log.log('diagnostics_saved');
  };
  // Perf trace (P3-T10, XAIBO_PERF_TRACE=1 only): the renderer acks a painted delta id; stamped first, so the time is an
  // upper bound that includes this one IPC hop. Only from our window, only a positive integer, IDs only.
  const trace = trusted.XAIBO_PERF_TRACE === '1' ? path.join(app.getPath('logs'), 'perf-trace-main.jsonl') : null;
  ipcMain.on('paint-ack', (e, delta: unknown) => {
    const t = process.hrtime.bigint();
    if (!trace || !win || e.sender !== win.webContents || !Number.isSafeInteger(delta) || (delta as number) <= 0) return;
    appendQuiet(trace, `${JSON.stringify({ ev: 'paint', delta, t: t.toString() })}\n`); // XAIBO-PROD-430: never throws
  });
  // "Set path…" (P1-T08/T12): only from our window, only an agent id; the user picks the file, the service validates it.
  // XAIBO-PROD-595 (P6-T08 slice E part 2; D-P6-19 1a): Import catalog entry. Only from our window, no argument; the user picks a
  // JSON file and the service reads and validates it (bounded). Importing grants nothing.
  ipcMain.on('import-catalog', (e) => {
    if (!win || !fromOurWindow(e, win)) return; // import review L2: our window's main frame only
    void dialog.showOpenDialog(win, { title: 'Choose an agent catalog entry', properties: ['openFile'], filters: [{ name: 'Agent catalog entry', extensions: ['json'] }] }).then((r) => {
      const file = r.filePaths[0];
      if (!r.canceled && file) supervisor.send({ v: IPC_VERSION, type: 'importCatalog', path: file });
    });
  });
  // XAIBO-PROD-597: Approve root / Grant probe / Grant setup. Our window's main frame only, ids only (parsed here); the outcome
  // carries no path or binding, and the log only the action and outcome (review L13).
  ipcMain.handle('grant', async (e, request: unknown): Promise<GrantOutcome> => {
    const ask = parseGrantAsk(request);
    if (!win || win.isDestroyed() || !fromOurWindow(e, win) || !ask) return { status: 'refused', code: 'invalid' };
    const out = await grants.ask(ask);
    log.log(`grant_${ask.action}_${out.status === 'refused' ? out.code : out.status}`);
    return out;
  });
  // XAIBO-PROD-600: Apply / Disconnect / Clean up on a real profile. Our window's main frame only, a kind and a preview id only
  // (parsed here); the outcome is the service's bound-checked reply; the log names only the kind and outcome.
  ipcMain.handle('confirm-apply', async (e, request: unknown): Promise<ApplyOutcome> => {
    const ask = parseApplyAsk(request);
    if (!win || win.isDestroyed() || !fromOurWindow(e, win) || !ask) return { status: 'refused', code: 'invalid' };
    const out = await applies.ask(ask);
    log.log(`apply_${ask.kind}_${out.status === 'refused' ? out.code : out.status}`);
    return out;
  });
  // XAIBO-PROD-623: Launch (options, preview, launch). Our window's main frame only, parsed here; the log names only the outcome.
  ipcMain.handle('launch', async (e, request: unknown): Promise<LaunchOptionsReply | LaunchPreviewReply | LaunchReply> => {
    const ask = parseLaunchAsk(request);
    if (!win || win.isDestroyed() || !fromOurWindow(e, win) || !ask) return { status: 'refused', code: 'invalid' };
    if (ask.op === 'options') return launches.options();
    if (ask.op === 'preview') return launches.preview(ask);
    const out = await launches.launch(ask.previewId);
    log.log(`launch_${out.status === 'refused' ? out.code : out.status}`);
    return out;
  });
  ipcMain.on('set-agent-path', (e, agent: unknown) => {
    if (!win || e.sender !== win.webContents || typeof agent !== 'string' || !AGENT_ID.test(agent)) return;
    void dialog.showOpenDialog(win, { title: 'Choose the agent executable', properties: ['openFile'] }).then((r) => {
      const file = r.filePaths[0];
      if (!r.canceled && file) supervisor.send({ v: IPC_VERSION, type: 'setPath', agent, path: file });
    });
  });

  // XAIBO-PROD-568 (P6-T11, SEC1; review R1-R3): Reveal override file. Our window's main frame only, no argument read; the
  // path is fixed in reveal.ts; Finder only selects. XAIBO_REVEAL_STUB=1 (E2E) records the kind only, never calls Finder.
  const revealStub = trusted.XAIBO_REVEAL_STUB === '1' ? path.join(app.getPath('logs'), 'reveal-stub.jsonl') : null;
  ipcMain.handle('reveal-price-override', (e): RevealResult => {
    if (!fromOurWindow(e, win)) return 'failed';
    const kind = revealOverride(dataDir, revealStub ? () => {} : (p) => shell.showItemInFolder(p));
    if (revealStub) appendQuiet(revealStub, `${JSON.stringify({ kind })}\n`);
    return kind;
  });

  // XAIBO-PROD-569 (P6-T10 unit 1, design §6.6 Startup): read or save Start at login for our main frame only; the request is
  // parsed in startup.ts. XAIBO_LOGIN_ITEM_STUB=1 (every E2E run) keeps it in a file, never the machine's login items.
  const loginItems: LoginItems = trusted.XAIBO_LOGIN_ITEM_STUB === '1' ? stubLoginItems(path.join(app.getPath('logs'), 'login-item-stub.json'))
    : { get: () => app.getLoginItemSettings().openAtLogin, set: (on) => app.setLoginItemSettings({ openAtLogin: on }) };
  ipcMain.handle('startup', (e, request: unknown): StartupReply => (fromOurWindow(e, win) ? answerStartup(request, loginItems) : { status: 'failed', code: 'invalid', enabled: null }));

  void app.whenReady().then(() => {
    sweepLaunchScripts(dataDir!); // XAIBO-PROD-623: scripts Terminal never ran
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
    win.on('close', (e) => { if (!quitting) { e.preventDefault(); hideWindow(win); } });
    win.webContents.on('did-start-loading', () => { pageReady = false; });
    win.webContents.on('did-finish-load', () => { pageReady = true; win?.webContents.send('health', supervisor.health); sendPort(); });
    void win.loadURL(dev ? `${dev}/` : `${APP_ORIGIN}/index.html`);
    forwardPower(powerMonitor, (c) => supervisor.send(c), Date.now); // P3-T12
    supervisor.start();
    log.log('app_ready', { packaged: app.isPackaged, trayReady: tray !== null });
  });
}
