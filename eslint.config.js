// Lint policy for src/ (plan P1-T01; PRD P2 zero network, SEC3 untrusted content).
// Everything else is only parsed. spikes/ is evidence and stays out of lint (typecheck covers it).
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const SPAWN_MODULE = 'src/service/spawn.ts';
// The hook socket server (P3-T02) needs node:net for a Unix socket in a private 0700 dir; nothing else in src/ may.
// No TCP: the M6 audit still checks every run for non-loopback connections.
const SOCKET_MODULES = ['src/service/receivers/socket.ts', 'src/forwarder/forwarder.ts']; // + the hook forwarder (P3-T03)
const NET = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises'];
// The statusLine tee (P3-T14, Q3-7) is a single-file SEA: it runs the owner's own original command (child_process) and
// sends its capture over the same private Unix socket (net). Nothing else in it may use either.
const TEE_MODULE = 'src/forwarder/statusline-tee.ts';
const netMsg = 'No network modules in src/ (PRD P2: zero non-loopback connections).';
const spawnMsg = `child_process only in ${SPAWN_MODULE}.`;

const netPaths = [
  ...NET.flatMap((m) => [m, `node:${m}`]).map((name) => ({ name, message: netMsg })),
  { name: 'undici', message: netMsg },
  { name: 'ws', message: netMsg },
  { name: 'electron', importNames: ['net'], message: netMsg },
  { name: 'electron', importNames: ['crashReporter'], message: 'No crash reporter (OQ-P1-10).' },
];
const spawnPaths = ['child_process', 'node:child_process'].map((name) => ({ name, message: spawnMsg }));
const spikePattern = { regex: '(^|/)spikes(/|$)', message: 'src/ never imports spikes/.' };

// esquery regex literals cannot contain "/", so \W stands in for a subpath separator.
const NET_RE = '/^(node:)?(http|https|http2|net|tls|dgram|dns|undici|ws)(\\W|$)/';
const SPAWN_RE = '/^(node:)?child_process$/';
const loads = (re, message) => [
  { selector: `ImportExpression[source.value=${re}]`, message },
  { selector: `CallExpression[callee.name='require'][arguments.0.value=${re}]`, message },
];
const crashMsg = 'No crash reporter (OQ-P1-10): errors become sanitized error-code log entries.';
const syntax = [
  { selector: "MemberExpression[object.name='crashReporter']", message: crashMsg },
  ...loads(NET_RE, netMsg),
  { selector: "MemberExpression[property.name='fetch']", message: netMsg },
  { selector: "MemberExpression[object.name=/^(globalThis|window|self)$/][property.name=/^(XMLHttpRequest|WebSocket|EventSource)$/]", message: netMsg },
  { selector: "MemberExpression[object.name='electron'][property.name='net']", message: netMsg },
  { selector: 'MemberExpression[property.name=/^(innerHTML|outerHTML|insertAdjacentHTML)$/]', message: 'Render untrusted text as text nodes (SEC3).' },
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Render untrusted text as text nodes (SEC3).' },
];

const src = ['src/**/*.{ts,tsx,cts,mts}'];

export default defineConfig([
  globalIgnores(['spikes/', 'dist/', 'out/', 'release/', '.cache/', '.claude/', '.handoff/', 'graphify-out/', 'test-results/', 'playwright-report/']),
  { files: ['**/*.{ts,tsx,cts,mts}'], languageOptions: { parser: tseslint.parser } },
  {
    files: src,
    rules: {
      'no-restricted-imports': ['error', { paths: [...netPaths, ...spawnPaths], patterns: [spikePattern] }],
      'no-restricted-globals': ['error', ...['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({ name, message: netMsg }))],
      'no-restricted-syntax': ['error', ...syntax, ...loads(SPAWN_RE, spawnMsg)],
    },
  },
  {
    files: SOCKET_MODULES,
    rules: {
      'no-restricted-imports': ['error', { paths: [...netPaths.filter((p) => p.name !== 'net' && p.name !== 'node:net'), ...spawnPaths], patterns: [spikePattern] }],
    },
  },
  {
    files: [TEE_MODULE],
    rules: {
      'no-restricted-imports': ['error', { paths: netPaths.filter((p) => p.name !== 'net' && p.name !== 'node:net'), patterns: [spikePattern] }],
      'no-restricted-syntax': ['error', ...syntax],
    },
  },
  {
    files: [SPAWN_MODULE],
    rules: {
      'no-restricted-imports': ['error', { paths: netPaths, patterns: [spikePattern] }],
      'no-restricted-syntax': ['error', ...syntax],
    },
  },
]);
