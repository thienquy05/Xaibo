// XAIBO-PROD-621 (P7-T04 slice B): the service's launch info for main's launch flow (design §6.7): per catalog agent its name,
// detected version, the executable as found (before realpath: a native install's realpath is a version file, which the
// catalog name check would refuse), the catalog names, the bundled template or the disabled reason, and its profiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../../src/service/catalog/validate.ts';
import { NOT_VERIFIED } from '../../../src/service/catalog/launch-templates.ts';
import type { Detection, Profile } from '../../../src/service/catalog/detect.ts';
import { launchInfo } from '../../../src/service/launch/info.ts';
import { parseServiceCommand, parseServiceEvent } from '../../../src/shared/ipc.ts';

const catalog = loadCatalog();
const HOME = '/synthetic-home';
const id = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 };
const detections: Detection[] = [
  { agent: 'claude', state: 'detected', path: `${HOME}/.local/share/claude/versions/2.1.332`, found: `${HOME}/.local/bin/claude`, version: '2.1.332', id, manual: false },
  { agent: 'codex', state: 'detected', path: '/opt/synthetic/codex.js', version: '0.160.0', id, manual: false },
  { agent: 'agy', state: 'not-detected' },
];
const profiles: Profile[] = [
  { id: 'p1', agent: 'claude', root: `${HOME}/.claude`, origin: 'default' },
  { id: 'p2', agent: 'claude', root: `${HOME}/work/claude-alt`, origin: 'manual' },
  { id: 'p3', agent: 'codex', root: '/Volumes/synthetic/codex', origin: 'env' },
];

test('launch info: found path, names, template or reason, profiles with labels; not detected has no executable', () => {
  const info = launchInfo(catalog, detections, profiles, HOME);
  assert.deepEqual(info.map((a) => a.agent), ['claude', 'codex', 'agy']);
  const [claude, codex, agy] = info;
  assert.deepEqual(claude, {
    agent: 'claude', name: 'Claude Code', version: '2.1.332', executable: `${HOME}/.local/bin/claude`,
    names: catalog.agents.find((a) => a.id === 'claude')!.detection.binaries.flatMap((b) => b.names),
    launch: { args: ['--session-id', '{id}'], preallocatedId: true },
    profiles: [{ id: 'p1', label: 'Default profile', default: true }, { id: 'p2', label: '~/work/claude-alt', default: false }],
  });
  assert.equal(codex!.executable, '/opt/synthetic/codex.js', 'no found path: the realpath');
  assert.deepEqual(codex!.launch, { args: [], preallocatedId: false });
  assert.deepEqual(codex!.profiles, [{ id: 'p3', label: '/Volumes/synthetic/codex', default: false }]);
  assert.deepEqual({ ...agy, names: [] }, { agent: 'agy', name: catalog.agents.find((a) => a.id === 'agy')!.displayName, version: null, executable: null, names: [],
    launch: { disabled: 'agy interactive launch not verified' }, profiles: [] });
  assert.deepEqual(launchInfo(null, detections, profiles, HOME), [], 'no catalog: nothing to launch');
  assert.deepEqual(launchInfo(catalog, [], null, HOME).map((a) => [a.executable, a.profiles.length]), [[null, 0], [null, 0], [null, 0]]);
  assert.equal(NOT_VERIFIED.length > 0, true);
});

test('launchInfo command and event: exact keys, bounded, main only', () => {
  assert.deepEqual(parseServiceCommand({ v: 1, type: 'launchInfo', id: 7 }), { v: 1, type: 'launchInfo', id: 7 });
  assert.equal(parseServiceCommand({ v: 1, type: 'launchInfo', id: 7, agent: 'claude' }), null);
  const agents = launchInfo(catalog, detections, profiles, HOME);
  assert.deepEqual(parseServiceEvent({ v: 1, type: 'launchInfo', id: 7, agents }), { v: 1, type: 'launchInfo', id: 7, agents });
  for (const bad of [
    { ...agents[0], executable: 'relative/claude' },
    { ...agents[0], agent: 'Bad Id' },
    { ...agents[0], names: Array(9).fill('claude') },
    { ...agents[0], launch: { args: ['x'], preallocatedId: 'yes' } },
    { ...agents[0], launch: { disabled: '' } },
    { ...agents[0], profiles: [{ id: 'p1' }] },
    { ...agents[0], extra: 1 },
  ]) assert.equal(parseServiceEvent({ v: 1, type: 'launchInfo', id: 7, agents: [bad] }), null, JSON.stringify(bad));
  assert.equal(parseServiceEvent({ v: 1, type: 'launchInfo', id: 7, agents: Array(65).fill(agents[2]) }), null, 'bounded');
});
