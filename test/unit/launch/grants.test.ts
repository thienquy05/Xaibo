// XAIBO-PROD-615 (P7-T03, EC-84; design .handoff/p7-designs.md, Claude from the plan, D-P7-02): launch grants. A private record
// per agent binds the executable's realpath and sha256, its absolute shebang interpreter (realpath and sha256), the argument
// template and the approved environment key names; it is revalidated immediately before each launch: any change is blocked
// as "renewal required" (naming the field), no grant is "grant required", and an unreadable record never grants. The
// launched environment is a fixed set plus the granted keys only: provider credentials never pass without an explicit grant.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { symlinkSync, unlinkSync } from 'node:fs';
import { fingerprint, grantLaunch, readGrants, revalidate, type LaunchSpec } from '../../../src/main/launch/grants.ts';
/** The owner confirmed what the dialog showed: the fingerprint taken before it opened. */
const grant = async (dataDir: string, agent: string, spec: LaunchSpec, origin: 'bundled' | 'imported', now: number) => grantLaunch(dataDir, agent, spec, origin, await fingerprint(spec.exe), now);

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function world() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xgrant-')));
  dirs.push(base);
  const interp = join(base, 'interp');
  copyFileSync('/bin/sh', interp);
  chmodSync(interp, 0o755);
  const exe = join(base, 'agent-cli');
  writeFileSync(exe, `#!${interp}\necho agent\n`, { mode: 0o755 });
  return { base, dataDir: join(base, 'data'), interp, exe, spec: { exe, template: ['--session-id', '{id}'], envKeys: ['ANTHROPIC_BASE_URL'] } };
}

test('a granted launch revalidates; each bound field changed in turn is blocked as renewal required', async () => {
  const w = world();
  assert.deepEqual(await revalidate(w.dataDir, 'claude', w.spec), { ok: false, blocked: 'grant required' });
  const g = await grant(w.dataDir, 'claude', w.spec, 'bundled', 1000);
  assert.equal(g.exeReal, w.exe);
  assert.match(g.exeSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(g.entry?.path, w.interp, 'the absolute shebang interpreter');
  assert.deepEqual(await revalidate(w.dataDir, 'claude', w.spec), { ok: true, exeReal: w.exe });
  const blocked = (field: string) => ({ ok: false, blocked: 'renewal required', field });
  assert.deepEqual(await revalidate(w.dataDir, 'claude', { ...w.spec, template: ['--session-id', '{id}', '--extra'] }), blocked('template'));
  assert.deepEqual(await revalidate(w.dataDir, 'claude', { ...w.spec, envKeys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'] }), blocked('env'));
  const other = join(w.base, 'agent-cli-2');
  copyFileSync(w.exe, other);
  chmodSync(other, 0o755);
  assert.deepEqual(await revalidate(w.dataDir, 'claude', { ...w.spec, exe: other }), blocked('exe'), 'same bytes, another file');
  writeFileSync(w.interp, readFileSync(w.interp).subarray(0, 64)); // the interpreter changed in place
  assert.deepEqual(await revalidate(w.dataDir, 'claude', w.spec), blocked('entry'));
  copyFileSync('/bin/sh', w.interp);
  assert.deepEqual(await revalidate(w.dataDir, 'claude', w.spec), { ok: true, exeReal: w.exe });
  writeFileSync(w.exe, `#!${w.interp}\necho changed\n`);
  assert.deepEqual(await revalidate(w.dataDir, 'claude', w.spec), blocked('exe-hash'));
  assert.deepEqual(await revalidate(w.dataDir, 'codex', w.spec), { ok: false, blocked: 'grant required' }, 'per agent');
});

test('the record is private and atomic; an unreadable or malformed record never grants; a bad agent id is refused', async () => {
  const w = world();
  await grant(w.dataDir, 'claude', w.spec, 'imported', 1);
  const f = join(w.dataDir, 'launch', 'grants.json');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(join(w.dataDir, 'launch')).mode & 0o777, 0o700);
  assert.equal(readGrants(w.dataDir)['claude']?.origin, 'imported');
  writeFileSync(f, '{"claude": 1}');
  assert.deepEqual(await revalidate(w.dataDir, 'claude', w.spec), { ok: false, blocked: 'grant required' });
  writeFileSync(f, 'not json');
  assert.deepEqual(readGrants(w.dataDir), {});
  await assert.rejects(grant(w.dataDir, '../x', w.spec, 'bundled', 1));
  await assert.rejects(grant(w.dataDir, 'claude', { ...w.spec, exe: 'relative' }, 'bundled', 1));
  // security review LOW: only a private regular file of ours is read
  await grant(w.dataDir, 'claude', w.spec, 'imported', 1);
  chmodSync(f, 0o644);
  assert.deepEqual(readGrants(w.dataDir), {}, 'readable by others');
  chmodSync(f, 0o600);
  const real = `${f}.real`;
  copyFileSync(f, real);
  unlinkSync(f);
  symlinkSync(real, f);
  assert.deepEqual(readGrants(w.dataDir), {}, 'a link');
  assert.deepEqual(await revalidate(w.dataDir, 'constructor', w.spec), { ok: false, blocked: 'grant required' }, 'never a prototype key');
});


// XAIBO-PROD-615 reviews: the grant binds what the owner was shown; key order is not a change; a relative #! never binds; a
// missing interpreter names the entry
test('the shown fingerprint binds; env keys are a set; a relative #! is refused; a missing interpreter is the entry', async () => {
  const w = world();
  const shown = await fingerprint(w.exe);
  writeFileSync(w.exe, `#!${w.interp}\necho swapped\n`);
  await assert.rejects(grantLaunch(w.dataDir, 'claude', w.spec, 'bundled', shown, 1), 'bytes swapped while the dialog was open');
  await assert.rejects(grantLaunch(w.dataDir, 'claude', w.spec, 'bundled', null, 1));
  await grant(w.dataDir, 'claude', { ...w.spec, envKeys: ['B', 'A', 'A'] }, 'bundled', 1);
  assert.deepEqual(readGrants(w.dataDir)['claude']?.envKeys, ['A', 'B']);
  assert.deepEqual(await revalidate(w.dataDir, 'claude', { ...w.spec, envKeys: ['A', 'B'] }), { ok: true, exeReal: w.exe });
  const rel = join(w.base, 'rel-cli');
  writeFileSync(rel, '#!node_modules/.bin/x\n', { mode: 0o755 });
  assert.equal(await fingerprint(rel), null, 'resolved against the launch cwd: never bound');
  unlinkSync(w.interp);
  assert.deepEqual(await revalidate(w.dataDir, 'claude', { ...w.spec, envKeys: ['A', 'B'] }), { ok: false, blocked: 'renewal required', field: 'entry' });
});
