// Lint policy for src/ (plan P1-T01; PRD P2 zero network, SEC3 untrusted content).
// Everything else is only parsed. spikes/ is evidence and stays out of lint (typecheck covers it).
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const SPAWN_MODULE = 'src/service/spawn.ts';
const NET = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises'];
const netMsg = 'No network modules in src/ (PRD P2: zero non-loopback connections).';
const spawnMsg = `child_process only in ${SPAWN_MODULE}.`;

const netPaths = [
  ...NET.flatMap((m) => [m, `node:${m}`]).map((name) => ({ name, message: netMsg })),
  { name: 'undici', message: netMsg },
  { name: 'ws', message: netMsg },
  { name: 'electron', importNames: ['net'], message: netMsg },
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
const syntax = [
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
    files: [SPAWN_MODULE],
    rules: {
      'no-restricted-imports': ['error', { paths: netPaths, patterns: [spikePattern] }],
      'no-restricted-syntax': ['error', ...syntax],
    },
  },
]);
