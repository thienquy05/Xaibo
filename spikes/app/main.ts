// XaiboSpike main: throwaway packaged app for Phase 0 spikes (P0-T03). Status lines go to stdout as JSON.
import { app, BrowserWindow, MessageChannelMain, nativeImage, session, Tray, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import path from 'node:path';
import { attempt } from '../s10/control.ts';

const RESTART_BASE_MS = 100;
const RESTART_CAP_MS = 5_000;
const HEALTHY_MS = 250; // ponytail: spike-only reset rule so S1's 200 kills do not sit at the cap; product sets its own
const ONE_SHOT = new Set(['s1-probe', 's9-zstd']);
const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);

const dataDir = process.env.XAIBO_DATA_DIR;
if (!dataDir || !path.isAbsolute(dataDir)) {
  say({ smoke: 'refused', reason: 'XAIBO_DATA_DIR must be an absolute path' });
  process.exit(1);
}
app.setPath('userData', dataDir);
app.setPath('sessionData', dataDir);
if (!app.requestSingleInstanceLock()) app.exit(0);
if (process.env.XAIBO_NETLOG) app.commandLine.appendSwitch('log-net-log', process.env.XAIBO_NETLOG); // S10-T2, spike env only

const mode = process.env.XAIBO_SPIKE_MODE ?? 'idle';
const here = import.meta.dirname;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: UtilityProcess | null = null;
let quitting = false;
let restarts = 0;
let loaded = false;
let serviceReady = false;

function connect() {
  if (!win || !service || !loaded || !serviceReady) return;
  const { port1, port2 } = new MessageChannelMain();
  service.postMessage({ type: 'port' }, [port1]);
  win.webContents.postMessage('port', null, [port2]);
}

function startService() {
  serviceReady = false;
  const startedAt = Date.now();
  service = utilityProcess.fork(path.join(here, 'service.js'), [mode], { serviceName: 'xaibo-spike-service', stdio: 'pipe' });
  service.stderr?.on('data', (d: Buffer) => say({ serviceStderr: d.toString().slice(0, 300) }));
  service.stdout?.resume();
  service.on('spawn', () => say({ 'service-pid': service?.pid }));
  service.on('message', (m) => {
    if (m?.type === 'ready') { serviceReady = true; say({ smoke: 'service-ready' }); connect(); }
    else if (m?.type === 'paint-ack') say({ smoke: 'paint-ack', id: m.id });
    else if (m?.type === 'ack') say({ ack: m.batch_seq });
    else if (m?.type === 'check') say({ check: m.check });
    else if (m?.type === 's3-hop' || m?.type === 's3-ready' || m?.type === 's3-stats') say({ [m.type]: m });
    else if (m?.type === 'report') { say({ report: m.report }); if (ONE_SHOT.has(mode)) app.quit(); }
    else say({ service: m });
  });
  service.on('exit', (code) => {
    service = null;
    if (quitting) return;
    if (Date.now() - startedAt >= HEALTHY_MS) restarts = 0;
    const delay = Math.min(RESTART_BASE_MS * 2 ** restarts++, RESTART_CAP_MS);
    say({ service: 'exit', code, restartInMs: delay });
    setTimeout(startService, delay);
  });
}

function lockDown() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((d, cb) => {
    const allowed = d.url.startsWith('file:');
    if (!allowed) say({ blocked: new URL(d.url).protocol });
    cb({ cancel: !allowed });
  });
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (e) => { e.preventDefault(); say({ blocked: 'navigate' }); });
    wc.setWindowOpenHandler(() => { say({ blocked: 'window-open' }); return { action: 'deny' }; });
  });
}

// S10 (XAIBO_S10=1, spike env only): driver commands on stdin, a line for every child that dies, and the positive
// controls (XAIBO_S10_CONTROL = main-tcp | main-dns; service-* is handled in service.ts).
function s10() {
  app.on('child-process-gone', (_e, d) => say({ 'child-gone': d.type, reason: d.reason, name: d.name ?? d.serviceName ?? '' }));
  app.on('render-process-gone', (_e, wc, d) => { say({ 'child-gone': 'Renderer', reason: d.reason }); wc.reload(); });
  const run = (cmd: string) => {
    if (cmd === 'hide') win?.hide();
    else if (cmd === 'show') win?.show();
    else if (cmd === 'crash-renderer') win?.webContents.forcefullyCrashRenderer();
    else if (cmd === 'open-blocked') void win?.webContents.executeJavaScript("window.open('https://example.invalid/'); fetch('https://example.invalid/').catch(() => {}); location.href = 'https://example.invalid/'; 0").catch(() => {});
    // NetLog control: a separate session has no request policy, so the request reaches Chromium's network stack.
    else if (cmd === 'fetch-control') void session.fromPartition('s10-control').fetch('https://example.invalid/').catch(() => {});
    else if (cmd === 'quit') app.quit();
    say({ s10: cmd });
  };
  let buf = '';
  process.stdin.on('data', (c: Buffer) => { buf += c; for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) run(buf.slice(0, i)); });
  const control = process.env.XAIBO_S10_CONTROL ?? '';
  if (control.startsWith('main-')) attempt(control.slice(5));
}

app.whenReady().then(() => {
  lockDown();
  if (process.env.XAIBO_S10 === '1') s10();
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('XS');
  win = new BrowserWindow({
    width: 480, height: 320,
    webPreferences: { preload: path.join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  // Paint measurement needs a visible, unoccluded window (an occluded window gets no frames, so no paint acks).
  if (mode === 's3') win.setAlwaysOnTop(true, 'floating');
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win?.hide(); } });
  win.webContents.on('did-finish-load', () => { loaded = true; connect(); });
  win.loadFile(path.join(here, '..', '..', 'index.html'));
  startService();
});

// Quit asks the service to exit cleanly (S10: a 'killed' report at quit is then always unexpected); a service that
// has not exited after 2 s is killed.
app.on('before-quit', (e) => {
  quitting = true;
  const s = service;
  if (!s) return;
  e.preventDefault();
  service = null;
  const timer = setTimeout(() => s.kill(), 2_000);
  s.once('exit', () => { clearTimeout(timer); app.quit(); });
  s.postMessage({ type: 'quit' });
});
app.on('window-all-closed', () => { /* tray app: stay alive */ });
process.on('SIGTERM', () => app.quit());
