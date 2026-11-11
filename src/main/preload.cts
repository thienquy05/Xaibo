// Sandboxed preload, one CommonJS file (R-P1-08): forwards the service port into the page (brokered from P1-T06) and
// exposes nothing else.
const { ipcRenderer } = require('electron') as typeof import('electron');

ipcRenderer.on('port', (e) => window.postMessage('xaibo-port', '*', e.ports));
