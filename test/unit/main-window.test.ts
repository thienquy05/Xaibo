// P4-T02: main hides and shows the window through these helpers and tells the page each time, because Electron 45
// on macOS emits no 'hide'/'show' and page visibility does not follow hide(); the page pauses live deltas while hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideWindow, showWindow } from '../../src/main/window.ts';

function fake() {
  const calls: string[] = [];
  const win = {
    hide: () => calls.push('hide'), show: () => calls.push('show'), focus: () => calls.push('focus'),
    webContents: { send: (ch: string, v: unknown) => calls.push(`${ch}:${String(v)}`) },
  };
  return { win, calls };
}

test('hideWindow hides, then tells the page it is not visible', () => {
  const f = fake();
  hideWindow(f.win);
  assert.deepEqual(f.calls, ['hide', 'visible:false']);
});

test('showWindow shows and focuses, then tells the page it is visible; no window is a no-op', () => {
  const f = fake();
  showWindow(f.win);
  assert.deepEqual(f.calls, ['show', 'focus', 'visible:true']);
  showWindow(null);
  hideWindow(null);
});
