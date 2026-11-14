// Window hide/show (P4-T02): each also tells the page, because Electron 45 on macOS emits no 'hide'/'show' here and
// page visibility does not follow hide(); the page pauses live deltas while hidden and resyncs by cursor when shown.
interface Win { hide(): void; show(): void; focus(): void; webContents: { send(channel: string, value: boolean): void } }

export function hideWindow(win: Win | null | undefined): void {
  if (!win) return;
  win.hide();
  win.webContents.send('visible', false);
}

export function showWindow(win: Win | null | undefined): void {
  if (!win) return;
  win.show();
  win.focus();
  win.webContents.send('visible', true);
}
