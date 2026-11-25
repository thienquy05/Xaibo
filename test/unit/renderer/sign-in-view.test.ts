// XAIBO-PROD-584 (P6-T10a unit 3; design .handoff/p6-t10a-design.md section 2, review R8/R9, D-P6-17): the sign-in fieldset
// model (usage/sign-in-view.ts) and the usage lead by method (usage/presentation.ts). Explicit Unknown differs from clear; every
// mutation carries the loaded revision; nothing changed sends nothing; stale needs review and a second Save; failed or lost keeps
// the draft and rereads; an old profile's reply changes nothing; one send per pending sequence; account change only without an
// unsaved edit. Provenance and reply words; consumption words; the lead per method.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SignInView, UsageConsumption } from '../../../src/shared/ipc.ts';
import { commandOf, settingsProfiles, draftOf, initialSignIn, METHOD_TEXT, provenanceLines, replyText, signInReducer, toSend, type SignInState } from '../../../src/renderer/usage/sign-in-view.ts';
import { consumptionLines, usageLead } from '../../../src/renderer/usage/presentation.ts';
import { formatTime } from '../../../src/renderer/model.ts';

const P = '00000000-0000-4000-8000-0000000c8401', Q = '00000000-0000-4000-8000-0000000c8402';
const view = (o: Partial<SignInView> = {}): SignInView => ({ profileId: P, revision: 3, method: 'unknown', source: null, at: null, declaration: null, evidence: null,
  conflict: false, usingDeclaration: false, outputStatus: 'unavailable', generation: 0, boundary: null, ...o });
const declared = (method: SignInView['method'], at = 1000) => view({ method, source: 'owner', at, declaration: { method, at }, usingDeclaration: true });
const ready = (v = view()): SignInState => signInReducer(signInReducer(initialSignIn, { type: 'select', profileId: P }), { type: 'loaded', profileId: P, code: 'ok', view: v });

test('draft and commands: explicit Unknown differs from clear; the loaded revision; nothing changed sends nothing', () => {
  assert.deepEqual(draftOf(view()), { mode: 'evidence', method: 'unknown' });
  assert.deepEqual(draftOf(declared('unknown')), { mode: 'declaration', method: 'unknown' }, 'an explicit Unknown declaration');
  assert.deepEqual(commandOf(view(), { mode: 'declaration', method: 'unknown' }, 'save'), { op: 'set', method: 'unknown', expectedRevision: 3 });
  assert.deepEqual(commandOf(declared('api-key'), { mode: 'evidence', method: 'api-key' }, 'save'), { op: 'clear', expectedRevision: 3 });
  assert.equal(commandOf(view(), { mode: 'evidence', method: 'unknown' }, 'save'), null, 'evidence already in use');
  assert.equal(commandOf(declared('gateway'), { mode: 'declaration', method: 'gateway' }, 'save'), null, 'the same declaration');
  assert.deepEqual(commandOf(declared('gateway'), draftOf(declared('gateway')), 'clear'), { op: 'clear', expectedRevision: 3 });
  assert.equal(commandOf(view(), draftOf(view()), 'clear'), null, 'nothing declared');
  assert.deepEqual(commandOf(view(), draftOf(view()), 'account-change'), { op: 'account-change', expectedRevision: 3 });
  assert.deepEqual(Object.values(METHOD_TEXT), ['Subscription', 'API key', 'Cloud provider', 'Gateway', 'Mixed', 'Unknown']);
});

test('save: one pending command per sequence; the reply installs the returned view; a reply for an older sequence or profile changes nothing', () => {
  let s = signInReducer(ready(), { type: 'edit', draft: { mode: 'declaration', method: 'subscription' } });
  assert.equal(s.dirty, true);
  s = signInReducer(s, { type: 'save' });
  assert.deepEqual(s.pending, { seq: 1, command: { op: 'set', method: 'subscription', expectedRevision: 3 } });
  assert.deepEqual(toSend(s, 0), s.pending);
  assert.equal(toSend(s, 1), null, 'review L8: once per seq');
  assert.equal(signInReducer(s, { type: 'save' }), s, 'frozen while applying: no second send');
  assert.equal(signInReducer(s, { type: 'edit', draft: { mode: 'evidence', method: 'unknown' } }), s, 'no edit while applying');
  assert.equal(signInReducer(s, { type: 'replied', seq: 0, code: 'ok', view: declared('gateway') }), s, 'an older sequence');
  const done = signInReducer(s, { type: 'replied', seq: 1, code: 'ok', view: declared('subscription') });
  assert.deepEqual([done.pending, done.dirty, done.view?.declaration?.method, done.text], [null, false, 'subscription', 'Declaration saved.']);
  const switched = signInReducer(s, { type: 'select', profileId: Q });
  assert.equal(signInReducer(switched, { type: 'replied', seq: 1, code: 'ok', view: declared('subscription') }), switched, 'the old profile\'s reply');
  assert.equal(signInReducer(switched, { type: 'loaded', profileId: P, code: 'ok', view: view() }), switched, 'the old profile\'s read');
  assert.deepEqual([switched.draft, switched.view, switched.dirty], [null, null, false], 'a profile switch carries no draft or revision');
  const none = signInReducer(ready(), { type: 'save' });
  assert.deepEqual([none.pending, none.text], [null, 'No change to save.']);
});

test('stale keeps the draft, installs the latest view and needs review before another Save; a dirty draft survives a background read', () => {
  let s = signInReducer(signInReducer(ready(), { type: 'edit', draft: { mode: 'declaration', method: 'api-key' } }), { type: 'save' });
  s = signInReducer(s, { type: 'replied', seq: 1, code: 'stale', view: { ...declared('gateway', 2000), revision: 4 } });
  assert.deepEqual([s.review, s.draft, s.view?.revision, s.text], [true, { mode: 'declaration', method: 'api-key' }, 4, replyText('stale', 'set')]);
  assert.equal(signInReducer(s, { type: 'save' }).pending, null, 'never resubmitted until reviewed');
  s = signInReducer(s, { type: 'review' });
  assert.equal(s.review, false);
  assert.ok(signInReducer(s, { type: 'save' }).pending, 'then an explicit Save');
  let b = signInReducer(ready(), { type: 'edit', draft: { mode: 'declaration', method: 'mixed' } });
  b = signInReducer(b, { type: 'loaded', profileId: P, code: 'ok', view: view({ revision: 3 }) });
  assert.deepEqual([b.draft, b.review], [{ mode: 'declaration', method: 'mixed' }, false], 'the same revision: the edit stays');
  b = signInReducer(b, { type: 'loaded', profileId: P, code: 'ok', view: { ...declared('gateway', 2000), revision: 4 } });
  assert.deepEqual([b.draft, b.review], [{ mode: 'declaration', method: 'mixed' }, true], 'a new revision under an edit: review first');
});

test('failed or lost keeps the draft and rereads (never repeats); account change only with no unsaved edit; refusals', () => {
  let s = signInReducer(signInReducer(ready(), { type: 'edit', draft: { mode: 'declaration', method: 'api-key' } }), { type: 'save' });
  const lost = signInReducer(s, { type: 'lost', seq: 1 });
  assert.deepEqual([lost.pending, lost.dirty, lost.reload, lost.text], [null, true, 1, replyText('failed', 'set')]);
  const failed = signInReducer(s, { type: 'replied', seq: 1, code: 'failed', view: null });
  assert.equal(failed.reload, 1);
  const dirty = signInReducer(ready(), { type: 'edit', draft: { mode: 'declaration', method: 'api-key' } });
  const refused = signInReducer(dirty, { type: 'account' });
  assert.deepEqual([refused.pending, refused.text], [null, 'Save or discard the declaration edit first.']);
  s = signInReducer(ready(), { type: 'account' });
  assert.deepEqual(s.pending?.command, { op: 'account-change', expectedRevision: 3 });
  const acct = signInReducer(s, { type: 'replied', seq: 1, code: 'ok', view: view({ revision: 4, generation: 1, boundary: { at: 5000, reason: 'declared-account' } }) });
  assert.equal(acct.text, 'Account change declared; usage epoch updated.');
  const gone = signInReducer(signInReducer(ready(), { type: 'account' }), { type: 'replied', seq: 1, code: 'profile-not-found', view: null });
  assert.deepEqual([gone.writable, gone.text], [false, 'This profile is no longer available. Choose another profile.']);
  const limit = signInReducer(signInReducer(ready(), { type: 'account' }), { type: 'replied', seq: 1, code: 'limit', view: view({ revision: 3 }) });
  assert.equal(limit.text, 'Sign-in changes are currently limited. No change was applied.');
  assert.equal(replyText('read-only', 'clear'), 'Sign-in changes are unavailable while the store is read-only.');
  assert.equal(replyText('ok', 'clear'), 'Declaration cleared; using agent evidence.');
});

test('provenance: effective method, both sides when they disagree, ambiguous evidence, Claude source time unknown, epoch', () => {
  assert.deepEqual(provenanceLines(view()), ['Sign-in method: Unknown', 'No sign-in evidence from agent output.']);
  const both = view({ method: 'api-key', source: 'owner', at: 1000, declaration: { method: 'api-key', at: 1000 }, usingDeclaration: true, conflict: true, outputStatus: 'matched',
    evidence: { method: 'subscription', source: 'claude-statusline', version: '2.1.332', ruleId: 'claude-a', observedAt: 2000, sourceAt: 2000 }, generation: 2, boundary: { at: 1000, reason: 'method' } });
  assert.deepEqual(provenanceLines(both), [
    'Sign-in method: API key',
    `Owner declaration: API key · declared ${formatTime(1000)}`,
    `Agent evidence: Subscription · Claude status line · source time unknown; observed ${formatTime(2000)}`,
    'Using owner declaration. Agent evidence disagrees.',
    `Usage epoch 2 since ${formatTime(1000)} (sign-in method change)`,
  ]);
  assert.ok(provenanceLines(view({ outputStatus: 'ambiguous' })).includes('Agent evidence is ambiguous; it is not used.'));
});

test('usage lead per method; consumption words: tokens, ~$ estimate, list price for cloud provider and gateway, partial, capped', () => {
  assert.deepEqual((['subscription', 'api-key', 'cloud-provider', 'gateway', 'mixed', 'unknown'] as const).map(usageLead), ['quota', 'consumption', 'consumption', 'consumption', 'both', 'none']);
  const c: UsageConsumption = { generation: 0, scope: null, tokens: 12345, estimatedUsd: 1.234, coverage: 'full', from: 1000, to: 2000, limited: false };
  assert.deepEqual(consumptionLines(c, 'api-key'), [`Retained observed consumption, ${formatTime(1000)} to ${formatTime(2000)}`, 'Observed tokens: 12,345', 'Estimated cost: ~$1.23']);
  assert.equal(consumptionLines(c, 'gateway')[2], 'Estimated cost: ~$1.23 (list-price estimate)');
  const partial = consumptionLines({ ...c, coverage: 'partial', estimatedUsd: null, tokens: null }, 'unknown');
  assert.deepEqual(partial.slice(1), ['Observed tokens: Unavailable', 'Estimated cost: Unavailable', 'Known subtotal: some requests are missing tokens or estimates.']);
  // review L6: capped only: nothing is missing, older requests are just not read
  assert.deepEqual(consumptionLines({ ...c, coverage: 'partial', limited: true }, 'api-key').slice(3), ['Older requests beyond the read limit are not counted.']);
});

test('XAIBO-PROD-586 (unit 4b): Settings lists every profile from the usage reply, named agent and profile (visible), declarable when its id is a UUID', () => {
  const p = (profileId: string, agent: string, label: string) => ({ profileId, agent, label, signIn: null, consumption: [], consumptionLimited: false });
  const names: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };
  const rlo = String.fromCharCode(0x202e), bs = String.fromCharCode(92);
  assert.deepEqual(settingsProfiles([p(P, 'codex', '~/work' + rlo), p('reg-key', 'acme', 'registration:r1'), p(Q, 'claude', 'Default profile')], (a) => names[a] ?? a), [
    { profileId: P, agent: 'codex', label: 'Codex · ~/work' + bs + 'u202E', declarable: true },
    { profileId: 'reg-key', agent: 'acme', label: 'acme · registration:r1', declarable: false },
    { profileId: Q, agent: 'claude', label: 'Claude Code · Default profile', declarable: true },
  ], 'review M1: a bidi control never disguises which profile is shown; M2: registration profiles are listed, not declarable');
});

test('unit 4a review L7: a write answered unavailable keeps the draft and rereads (its words promise a retry)', () => {
  const s = signInReducer(signInReducer(ready(), { type: 'edit', draft: { mode: 'declaration', method: 'api-key' } }), { type: 'save' });
  const u = signInReducer(s, { type: 'replied', seq: 1, code: 'unavailable', view: null });
  assert.deepEqual([u.pending, u.dirty, u.reload], [null, true, 1]);
});

test('unit 3 review M1-M3, L4, L5, L7: dirty follows the draft; discard; a clean draft follows a new view; older reads ignored; read codes', () => {
  let s = signInReducer(ready(), { type: 'edit', draft: { mode: 'declaration', method: 'api-key' } });
  s = signInReducer(s, { type: 'edit', draft: { mode: 'evidence', method: 'unknown' } });
  assert.equal(s.dirty, false, 'M1: back to the saved choice is not an edit');
  assert.ok(signInReducer(s, { type: 'account' }).pending, 'so account change is allowed');
  s = signInReducer(signInReducer(ready(), { type: 'edit', draft: { mode: 'declaration', method: 'api-key' } }), { type: 'discard' });
  assert.deepEqual([s.dirty, s.draft], [false, { mode: 'evidence', method: 'unknown' }], 'M1: discard');
  let a = signInReducer(ready(), { type: 'account' });
  a = signInReducer(a, { type: 'replied', seq: 1, code: 'stale', view: { ...declared('gateway', 2000), revision: 4 } });
  assert.deepEqual([a.draft, a.review], [{ mode: 'declaration', method: 'gateway' }, false], 'M2: a clean draft follows the latest view, no review needed');
  assert.equal(signInReducer(a, { type: 'save' }).pending, null, 'and Save then changes nothing (never clears the other window\'s declaration)');
  let o = signInReducer(ready(), { type: 'account' });
  o = signInReducer(o, { type: 'replied', seq: 1, code: 'ok', view: view({ revision: 4, generation: 1, boundary: { at: 5, reason: 'declared-account' } }) });
  assert.equal(signInReducer(o, { type: 'loaded', profileId: P, code: 'ok', view: view({ revision: 3 }) }), o, 'M3: an older read never replaces a newer view');
  const nf = signInReducer(signInReducer(initialSignIn, { type: 'select', profileId: P }), { type: 'loaded', profileId: P, code: 'profile-not-found', view: null });
  assert.deepEqual([nf.writable, nf.text], [false, replyText('profile-not-found', 'set')], 'L4: the read code counts');
  const lost = signInReducer(signInReducer(ready(), { type: 'account' }), { type: 'lost', seq: 1 });
  assert.equal(signInReducer(lost, { type: 'loaded', profileId: P, code: 'ok', view: view({ revision: 4 }) }).text, '', 'L5: a good reread clears the reload text');
  const p = signInReducer(ready(), { type: 'account' });
  assert.equal(signInReducer(p, { type: 'select', profileId: P }), p, 'L7: the same profile again keeps its pending command');
});
