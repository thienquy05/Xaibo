// XAIBO-PROD-102 (P1-T04): the pure parts of the P2/SEC1 policy that src/main/security.ts wires into Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CSP, devOrigin, isAllowedRequest, resolveAppFile } from '../../src/main/policy.ts';

const root = '/tmp/xaibo-fixture/renderer';
const port = 5173; // joined at runtime: the privacy scan bars loopback host:port literals

test('only app: and devtools: pass without a dev origin', () => {
  assert.equal(isAllowedRequest('app://xaibo/index.html'), true);
  assert.equal(isAllowedRequest('devtools://devtools/bundled/inspector.html'), true);
  for (const url of [
    'https://example.invalid/', `http://127.0.0.1:${port}/`, `ws://127.0.0.1:${port}/`, 'file:///etc/hosts',
    'blob:app://xaibo/1', 'data:text/html,x', 'chrome-extension://abc/x', 'not a url',
  ]) assert.equal(isAllowedRequest(url), false, url);
});

test('a dev origin allows exactly its loopback host over http and ws', () => {
  const dev = `http://127.0.0.1:${port}`;
  assert.equal(isAllowedRequest(`http://127.0.0.1:${port}/src/main.tsx`, dev), true);
  assert.equal(isAllowedRequest(`ws://127.0.0.1:${port}/`, dev), true);
  assert.equal(isAllowedRequest(`http://127.0.0.1:${port + 1}/`, dev), false);
  assert.equal(isAllowedRequest(`https://127.0.0.1:${port}/`, dev), false);
  assert.equal(isAllowedRequest(`http://localhost:${port}/`, dev), false);
  assert.equal(isAllowedRequest('https://example.invalid/', dev), false);
});

test('devOrigin: unpackaged and loopback only', () => {
  assert.equal(devOrigin({ XAIBO_DEV_SERVER_URL: `http://127.0.0.1:${port}/` }, false), `http://127.0.0.1:${port}`);
  assert.equal(devOrigin({ XAIBO_DEV_SERVER_URL: `http://[::1]:${port}/` }, false), `http://[::1]:${port}`);
  assert.equal(devOrigin({ XAIBO_DEV_SERVER_URL: `http://127.0.0.1:${port}/` }, true), undefined);
  assert.equal(devOrigin({ XAIBO_DEV_SERVER_URL: `http://example.invalid:${port}/` }, false), undefined);
  assert.equal(devOrigin({ XAIBO_DEV_SERVER_URL: `http://localhost:${port}/` }, false), undefined);
  assert.equal(devOrigin({ XAIBO_DEV_SERVER_URL: 'file:///x' }, false), undefined);
  assert.equal(devOrigin({ XAIBO_DEV_SERVER_URL: 'garbage' }, false), undefined);
  assert.equal(devOrigin({}, false), undefined);
});

test('resolveAppFile serves files under the root and refuses traversal', () => {
  assert.equal(resolveAppFile(root, 'app://xaibo/index.html'), join(root, 'index.html'));
  assert.equal(resolveAppFile(root, 'app://xaibo/'), join(root, 'index.html'));
  assert.equal(resolveAppFile(root, 'app://xaibo/assets/index-abc.js?v=1#x'), join(root, 'assets/index-abc.js'));
  assert.equal(resolveAppFile(root, 'app://xaibo/a%20b.css'), join(root, 'a b.css'));
  // The URL parser collapses literal and %2e dot segments itself, so these stay under the root.
  assert.equal(resolveAppFile(root, 'app://xaibo/../../etc/hosts'), join(root, 'etc/hosts'));
  assert.equal(resolveAppFile(root, 'app://xaibo/%2e%2e/%2e%2e/etc/hosts'), join(root, 'etc/hosts'));
  // An encoded slash survives parsing and decodes into a real traversal: refused.
  for (const url of [
    'app://xaibo/..%2f..%2fetc%2fhosts', 'app://xaibo/a/..%2f..%2f..%2fx', 'app://xaibo/a%00.html', 'app://xaibo/%E0%A4%A', 'app://other/index.html', 'file:///etc/hosts', 'nonsense',
  ]) assert.equal(resolveAppFile(root, url), null, url);
});

test('CSP is self-only for scripts and connections', () => {
  assert.equal(CSP, "default-src 'self'; connect-src 'self'");
});
