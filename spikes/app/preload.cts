// Sandboxed preload: forwards the service port into the page and exposes nothing else.
import { ipcRenderer } from 'electron';

ipcRenderer.on('port', (e) => window.postMessage('xaibo-port', '*', e.ports));
