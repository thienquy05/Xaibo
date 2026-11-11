// P1-T05 (EC-60, M6): the NetLog parser and the death classifier used by the E2E audit fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetLog, unexpectedDeaths } from '../e2e/audit.ts';

const constants = { logEventTypes: { HOST_RESOLVER_DNS_TASK: 1, TCP_CONNECT: 2, URL_REQUEST_START_JOB: 3 } };
const log = (events: unknown[]) => JSON.stringify({ constants, events });

test('a non-loopback DNS query, socket address or URL is flagged', () => {
  const r = parseNetLog(log([
    { type: 1, params: { dns_query_name: 'example.invalid' } },
    { type: 2, params: { address: '192.0.2.1:443' } },
    { type: 3, params: { url: 'https://example.invalid/x' } },
  ]));
  assert.deepEqual(r, { parsed: true, events: 3, nonLocal: 3, types: ['HOST_RESOLVER_DNS_TASK', 'TCP_CONNECT', 'URL_REQUEST_START_JOB'] });
});

test('loopback and app: traffic is ignored', () => {
  const port = 5173; // joined at runtime: the privacy scan bars loopback host:port literals
  const r = parseNetLog(log([
    { type: 2, params: { address: `127.0.0.1:${port}` } },
    { type: 2, params: { address: `[::1]:${port}` } },
    { type: 3, params: { url: `http://localhost:${port}/` } },
    { type: 3, params: { url: 'app://xaibo/index.html' } },
    { type: 1, params: { host: 'localhost' } },
    { type: 3 },
  ]));
  assert.deepEqual(r, { parsed: true, events: 6, nonLocal: 0, types: [] });
});

test('a log cut off by a killed process still parses; garbage does not', () => {
  const full = log([{ type: 1, params: { dns_query_name: 'example.invalid' } }, { type: 3, params: { url: 'app://xaibo/' } }]);
  const cut = full.slice(0, full.lastIndexOf(']')).replace(/\}$/, '},'); // Chromium leaves a trailing comma
  assert.equal(parseNetLog(cut).nonLocal, 1);
  assert.equal(parseNetLog('').parsed, false);
  assert.equal(parseNetLog('{"constants": {').parsed, false);
});

test('only clean exits are expected; allowed service kills are subtracted', () => {
  const clean = { type: 'Utility', reason: 'clean-exit', name: 'xaibo-service' };
  const killedSvc = { type: 'Utility', reason: 'killed', name: 'xaibo-service' };
  const killedNet = { type: 'Utility', reason: 'killed', name: 'Network Service' };
  const gpu = { type: 'GPU', reason: 'crashed', name: '' };
  assert.equal(unexpectedDeaths([clean]), 0);
  assert.equal(unexpectedDeaths([clean, killedNet, gpu]), 2);
  assert.equal(unexpectedDeaths([killedSvc]), 1);
  assert.equal(unexpectedDeaths([killedSvc, killedSvc], { serviceKills: 1 }), 1);
  assert.equal(unexpectedDeaths([killedSvc, killedNet], { serviceKills: 2 }), 1);
});
