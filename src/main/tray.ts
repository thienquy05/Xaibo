// Tray (P1-T04, S-13, US-9): Show, Save diagnostics… (P1-T13) and Quit.
import { Menu, nativeImage, Tray } from 'electron';

export function createTray(actions: { show: () => void; saveDiagnostics: () => void; quit: () => void }): Tray {
  const tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('Xaibo'); // ponytail: text title until the Gate D icon exists
  tray.setToolTip('Xaibo');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Xaibo', click: actions.show },
    { label: 'Save diagnostics…', click: actions.saveDiagnostics },
    { type: 'separator' },
    { label: 'Quit', click: actions.quit },
  ]));
  return tray;
}
