// XAIBO-PROD-625 (P7-T06; design §3.2, §6.9): the static ownership badge (16 px icon plus the exact words, no hover or active
// state, wrapping as one phrase) and the separate About ownership disclosure (a toggle that stays the trigger).
import { useId, useState } from 'react';
import { ABOUT_OWNERSHIP, OWNERSHIP_TEXT, type Ownership } from '../../service/status/ownership.ts';
import { Icon } from './StatusBadge.tsx';
import { OWNERSHIP_ICON, spokenPrefix } from './ownership-view.ts';

export function OwnershipBadge({ kind }: { kind: Ownership }) {
  const prefix = spokenPrefix(kind);
  return <span className={`x-own x-own-${kind}`} data-field="ownership"><span className="x-sr-only">. </span><Icon id={OWNERSHIP_ICON[kind]} />
    <span>{prefix ? <span className="x-sr-only">{prefix}</span> : null}{OWNERSHIP_TEXT[kind]}</span></span>;
}

export function AboutOwnership() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <>
    <button type="button" className="x-btn x-btn-secondary x-own-about" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>About ownership</button>
    <p id={id} className="x-own-note" hidden={!open}>{ABOUT_OWNERSHIP}</p>
  </>;
}
