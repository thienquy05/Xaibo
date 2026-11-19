// XAIBO-PROD-532 (P5-T18 part 3b-3; design §5.1 Menu): a More actions menu as a native popover (top layer, so no
// scroller clips it; light dismiss on Escape or an outside click; hiding returns focus to the invoking trigger), placed
// at its invoker by CSS anchor positioning. Items are menuitem / menuitemcheckbox buttons with roving focus (menu-model).
// Each trigger names its record and sets popoverTarget to this menu's id. While entries load, focus stays on the trigger.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../status/StatusBadge.tsx';
import { menuKey } from './menu-model.ts';

/** checked: a toggle's state (menuitemcheckbox), null for a plain action. */
export interface MenuEntry { key: string; label: string; checked: boolean | null; onSelect(): void; /** e.g. Retry: the menu stays open */ keepOpen?: true }

export function Menu({ id, label, entries, note }: { id: string; label: string; entries: MenuEntry[]; note: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  const loaded = entries.length > 0;
  useEffect(() => { if (open && loaded) items()[0]?.focus(); }, [open, loaded]); // the first item, once there are items
  return (
    <div id={id} ref={ref} popover="auto" className="x-menu" onToggle={(e) => setOpen((e.nativeEvent as ToggleEvent).newState === 'open')}
      onKeyDown={(e) => {
        if (e.key === 'Tab') { e.preventDefault(); ref.current?.hidePopover(); return; } // leaves through its trigger
        const list = items();
        const n = menuKey(e.key, Math.max(0, list.indexOf(document.activeElement as HTMLElement)), entries.map((x) => x.label));
        if (n === null) return;
        e.preventDefault();
        list[n]?.focus();
      }}>
      <div aria-live="polite">{note}</div>{/* mounted before its text, so Loading and failures are read */}
      {loaded ? (
        <div role="menu" aria-label={label}>
          {entries.map((x) => (
            <button key={x.key} type="button" tabIndex={-1} className="x-menu-item" role={x.checked === null ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={x.checked ?? undefined} onClick={() => { if (!x.keepOpen) ref.current?.hidePopover(); x.onSelect(); }}>
              <span className="x-menu-check">{x.checked ? <Icon id="check" /> : null}</span>{x.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
