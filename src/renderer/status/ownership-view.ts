// XAIBO-PROD-625 (P7-T06; design §3.2, §6.9, C27): the ownership badge's view model over the ownership classifier
// (service/status/ownership.ts). The MVP has no authoritative control or detached evidence, so every session is Observed
// externally, a session Xaibo launched in Terminal included; health Detached never becomes ownership. A provisional launch row
// is Ownership unavailable (it is not yet a session).
import { ownership, type Ownership } from '../../service/status/ownership.ts';
import type { SessionRow } from '../../shared/ipc.ts';
import type { IconId } from './icons.ts';

export const OWNERSHIP_ICON: Record<Ownership, IconId> = { 'observed-externally': 'external', 'controlled-here': 'control', detached: 'unlink', unavailable: 'unknown' };
/** 625 a11y review: read as the Ownership field (design C27); hidden where the visible words do not say it already. */
export const spokenPrefix = (o: Ownership) => (o === 'observed-externally' || o === 'controlled-here' ? 'Ownership: ' : '');
/** ponytail: no evidence fields yet (v1-A adds Xaibo-hosted control and authoritative detach to the session row). */
export const ownershipOf = (_row: Pick<SessionRow, 'id'>): Ownership => ownership({});
