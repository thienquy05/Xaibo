// P7-T12 (packaged hardening; XAIBO-PROD-611 follow-up): the packaged build turns off the Electron fuses that let an inherited
// environment run the app binary as plain Node (ELECTRON_RUN_AS_NODE) or inject code at startup (NODE_OPTIONS). The inspect-
// arguments fuse stays on: Playwright's _electron attaches to main through --inspect (ponytail: turn it off once the E2E suite
// no longer needs it). Reads the fuse wire in the packaged Electron Framework (sentinel, version byte, length byte, '0'/'1').
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const FRAMEWORK = path.join(import.meta.dirname, '..', '..', 'release', 'mac-arm64', 'Xaibo.app', 'Contents', 'Frameworks',
  'Electron Framework.framework', 'Electron Framework');
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'); // privacy-scan:allow Electron's public fuse-wire sentinel (@electron/fuses)
const RUN_AS_NODE = 0, NODE_OPTIONS = 2, INSPECT = 3; // @electron/fuses FuseV1Options

test('packaged build: RunAsNode and NODE_OPTIONS fuses are off', () => {
  const bin = readFileSync(FRAMEWORK);
  const at = bin.indexOf(SENTINEL);
  expect(at, 'fuse sentinel').toBeGreaterThan(-1);
  expect(bin.indexOf(SENTINEL, at + 1), 'one fuse wire').toBe(-1);
  const o = at + SENTINEL.length;
  expect(bin[o], 'fuse wire version').toBe(1);
  const wire = bin.subarray(o + 2, o + 2 + bin[o + 1]!).toString('latin1');
  expect(wire[RUN_AS_NODE]).toBe('0');
  expect(wire[NODE_OPTIONS]).toBe('0');
  expect(wire[INSPECT], 'kept on for Playwright').toBe('1');
});
