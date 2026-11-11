// Sandboxed preload, one CommonJS file (R-P1-08): forwards the brokered service port and main's health messages into
// the page (P1-T06), which validates what it receives (src/shared/ipc.ts). The page's only call into main is
// `xaibo.setAgentPath(agent)`, which opens the native file dialog (P1-T12); main checks the sender and the agent id.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

ipcRenderer.on('port', (e) => window.postMessage('xaibo-port', '*', e.ports));
ipcRenderer.on('health', (_e, health: unknown) => window.postMessage(health, '*'));
contextBridge.exposeInMainWorld('xaibo', { setAgentPath: (agent: string) => ipcRenderer.send('set-agent-path', String(agent)) });
