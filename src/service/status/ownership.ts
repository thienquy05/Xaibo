// XAIBO-PROD-618 (P7-T06; FR-23, design §3.2 and §6.9): a session's ownership badge state. Observation never grants control:
// "Controlled here" needs authoritative, live and fresh control held by this Xaibo (the v1-A PTY evidence; nothing in the MVP
// produces it); launch origin, stale or unknown authority never establishes it (EC-76). "Detached" needs authoritative
// evidence (health Detached is a separate dimension and never substitutes). A provisional launch row is not yet a session.
// Everything else, including a session Xaibo launched in an external terminal, is "Observed externally". The renderer badge
// comes with the UI slice after the owner's mock review.
export type Ownership = 'observed-externally' | 'controlled-here' | 'detached' | 'unavailable';
export interface OwnershipEvidence {
  /** A provisional launch row no session evidence has bound yet. */
  provisional?: boolean;
  /** Control evidence (v1-A): only this Xaibo, live and fresh, counts. */
  control?: { holder: 'this-xaibo' | 'other'; live: boolean; fresh: boolean } | null;
  /** Authoritative evidence that a session Xaibo controlled was detached (v1-A). */
  detached?: { authoritative: boolean } | null;
}

export function ownership(e: OwnershipEvidence): Ownership {
  if (e.provisional) return 'unavailable';
  if (e.detached?.authoritative) return 'detached'; // contradicting a control claim: fail closed (618 review LOW)
  return e.control?.holder === 'this-xaibo' && e.control.live && e.control.fresh ? 'controlled-here' : 'observed-externally';
}

export const OWNERSHIP_TEXT: Record<Ownership, string> = {
  'observed-externally': 'Observed externally', 'controlled-here': 'Controlled here', detached: 'Ownership: Detached',
  unavailable: 'Ownership unavailable — awaiting session evidence',
};
export const ABOUT_OWNERSHIP = 'Observation does not grant control. Sessions opened in an external terminal are observed externally, including launches from Xaibo.';
