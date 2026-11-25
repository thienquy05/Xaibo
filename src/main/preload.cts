// Sandboxed preload, one CommonJS file (R-P1-08): forwards the brokered service port and main's health messages into
// the page (P1-T06), which validates what it receives (src/shared/ipc.ts). The page's calls into main are
// `xaibo.setAgentPath(agent)`, which opens the native file dialog (P1-T12; main checks the sender and the agent id), and
// `xaibo.revealPriceOverride()` (P6-T11), which takes no argument and asks Finder to select the price override file, and
// `xaibo.startup(request)` (P6-T10 unit 1), Start at login read/save, parsed again in main.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

ipcRenderer.on('port', (e) => window.postMessage('xaibo-port', '*', e.ports));
ipcRenderer.on('health', (_e, health: unknown) => window.postMessage(health, '*'));
// P4-T02: main's window hide/show (src/main/window.ts; page visibility does not follow hide() on macOS).
ipcRenderer.on('visible', (_e, on: unknown) => window.postMessage({ xaiboVisible: on === true }, '*'));
// P3-T10: `paintAck(delta)` reports a painted delta id; main records it only under XAIBO_PERF_TRACE=1.
contextBridge.exposeInMainWorld('xaibo', {
  setAgentPath: (agent: string) => ipcRenderer.send('set-agent-path', String(agent)),
  paintAck: (delta: number) => ipcRenderer.send('paint-ack', Number(delta)),
  revealPriceOverride: () => ipcRenderer.invoke('reveal-price-override') as Promise<unknown>,
  startup: (request: unknown) => ipcRenderer.invoke('startup', request) as Promise<unknown>,
});
