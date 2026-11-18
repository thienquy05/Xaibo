// XAIBO-PROD-439 (P4-T15b; WCAG 2.4.11, design §2.3/§6.0): focus scrolled into view never lands under the sticky top
// frame. Below 1200 px the frame is a sticky top bar of variable height (wrapping nav, large text): the scroll padding
// reserves its height plus room for the focus ring; at 1200 px and wider the frame is the left rail, nothing above.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framePad } from '../../../src/renderer/frame-pad.ts';

test('framePad: the sticky top bar height plus 8 px below 1200 px; 8 px with the rail or a non-sticky frame', () => {
  assert.equal(framePad(56, 960, true), 64);
  assert.equal(framePad(130, 320, true), 138, 'wrapped nav at 320 CSS px');
  assert.equal(framePad(56, 1200, true), 8);
  assert.equal(framePad(0, 700, true), 8);
  assert.equal(framePad(300, 320, false), 8, 'a short viewport: the frame scrolls away, nothing to clear');
});
