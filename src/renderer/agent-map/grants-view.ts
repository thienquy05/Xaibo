// XAIBO-PROD-598 (P6-T08a slice C; D-P6-20, SEC5): the grants fieldset model, pure. One row per declared item of an imported
// agent: each profile folder, each version probe, the setup writes; the state in words, the grant action that main confirms
// natively (the renderer sends ids only) and Revoke beside any stored authority (granted or stale). Grants wait with a reason
// while no folder is allowed (production) or the item's folder is not approved; Revoke stays offered (it only removes
// authority). Outcome texts never claim a grant that may not exist. No paths, digests, argv or ops reach the renderer.
import { parseGrantOutcome, type GrantAsk, type GrantOutcome, type GrantState, type RevokeResult, type RevokeTarget } from '../../shared/ipc.ts';

export interface GrantRow { key: string; label: string; state: string; grant: { ask: GrantAsk; label: string; disabled: string | null } | null; revoke: RevokeTarget | null }
export const NOT_ALLOWED = 'Imported profile folders cannot be approved in this version of Xaibo, so nothing can be granted.';
const FIRST = 'Approve a profile folder first.';
const ROOT_STATE = { approved: 'Approved', stale: 'No longer matches the folder', none: 'Not approved', unavailable: 'Unavailable' } as const;
const ITEM_STATE = { granted: 'Granted', stale: 'No longer matches', none: 'Not granted' } as const;

/** The fieldset's reason when no declared folder is allowed at all (production: none is). */
export const grantsNote = (g: GrantState): string | null => (g.roots.every((r) => r.state === 'unavailable') ? NOT_ALLOWED : null);

export function grantRows(agent: string, g: GrantState): GrantRow[] {
  const none = grantsNote(g), approved = (id?: string) => g.roots.some((r) => r.state === 'approved' && (id === undefined || r.id === id));
  const roots = g.roots.map((r): GrantRow => ({
    key: `root:${r.id}`, label: `Profile folder ${r.id}`, state: ROOT_STATE[r.state],
    grant: r.state === 'approved' ? null : { ask: { action: 'root', agent, root: r.id }, label: 'Approve root', disabled: none ?? (r.state === 'unavailable' ? NOT_ALLOWED : null) },
    revoke: r.state === 'approved' || r.state === 'stale' ? { kind: 'root', id: r.id } : null,
  }));
  const probes = g.probes.map((p): GrantRow => ({
    key: `probe:${p.binary}`, label: `Version probe ${p.binary}`, state: ITEM_STATE[p.state],
    grant: p.state === 'granted' ? null : { ask: { action: 'probe', agent, binary: p.binary }, label: 'Grant probe', disabled: none ?? (approved() ? null : FIRST) },
    revoke: p.state === 'none' ? null : { kind: 'probe', id: p.binary },
  }));
  const s = g.setup;
  const setup: GrantRow[] = s ? [{
    key: 'setup', label: 'Setup writes', state: ITEM_STATE[s.state],
    grant: s.state === 'granted' ? null : { ask: { action: 'setup', agent }, label: 'Grant setup', disabled: none ?? (approved(s.root) ? null : FIRST) },
    revoke: s.state === 'none' ? null : { kind: 'setup' },
  }] : [];
  return [...roots, ...probes, ...setup];
}

const GRANTED: Record<GrantAsk['action'], string> = { root: 'Profile folder approved.', probe: 'Version probe granted.', setup: 'Setup writes granted.' };
const NOTHING = 'Nothing was granted.';
const REFUSED: Record<Extract<GrantOutcome, { status: 'refused' }>['code'], string> = {
  'not-found': `This agent or item is no longer listed. ${NOTHING}`,
  'root-unavailable': `This folder cannot be approved here. ${NOTHING}`,
  'root-not-approved': `Approve the profile folder first. ${NOTHING}`,
  'executable-invalid': `That file cannot be granted: choose a private executable inside the approved folder. ${NOTHING}`,
  stale: `What was shown changed before it was confirmed. ${NOTHING} Try again.`,
  busy: 'Another grant is open. Finish it first.',
  unavailable: `Grants are unavailable right now. ${NOTHING}`,
  failed: `The grant failed. ${NOTHING}`,
  invalid: `The request was not accepted. ${NOTHING}`,
  oversize: `The confirmation was too long to show in full. ${NOTHING}`,
  unknown: 'No reply came in time; the grant may have been saved. The state below was read again.',
};
export const outcomeText = (action: GrantAsk['action'], o: GrantOutcome): string =>
  (o.status === 'granted' ? GRANTED[action] : o.status === 'cancelled' ? `Cancelled. ${NOTHING}` : REFUSED[o.code]);
const REVOKE: Record<RevokeResult, string> = {
  revoked: 'Revoked.', unchanged: 'Nothing was stored to revoke.', 'not-found': 'This agent is no longer listed.', unavailable: 'Revoke is unavailable right now.',
};
export const revokeText = (r: RevokeResult) => REVOKE[r];

/** Main's answer, strictly: no bridge sends nothing (unavailable); a malformed or failed reply may follow a write (unknown). */
export async function askGrant(bridge: ((request: unknown) => Promise<unknown>) | undefined, a: GrantAsk): Promise<GrantOutcome> {
  if (!bridge) return { status: 'refused', code: 'unavailable' };
  try { return parseGrantOutcome(await bridge(a)) ?? { status: 'refused', code: 'unknown' }; } catch { return { status: 'refused', code: 'unknown' }; }
}
