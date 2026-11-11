// Performance marks (P1-T14, M3, OQ-P1-09) through the standard User Timing API, read by test/perf (no test hook):
// the first-usable-page mark two frames after the first commit with a row (painted, handlers attached), and long
// frames above 100 ms as measures (long-animation-frame, else longtask). Reported at Gate 1, enforced from Gate 2.
export const FIRST_PAGE_MARK = 'xaibo:first-usable-page';
export const LONG_FRAME = 'xaibo:long-frame';
const LONG_MS = 100;

/** Returns the commit hook: call it with the row count after each list commit. */
export function firstUsablePage(d: { raf: (cb: () => void) => void; mark: (name: string) => void }): (rows: number) => void {
  let scheduled = false;
  return (rows) => {
    if (scheduled || rows < 1) return;
    scheduled = true;
    d.raf(() => d.raf(() => d.mark(FIRST_PAGE_MARK)));
  };
}

interface Observer { observe(o: { type: string; buffered: boolean }): void }
interface ObserverCtor {
  new (cb: (list: { getEntries(): { startTime: number; duration: number }[] }) => void): Observer;
  readonly supportedEntryTypes?: readonly string[];
}

/** Observes long frames; returns the entry type in use, or null if none is supported. */
export function watchLongFrames(record: (start: number, duration: number) => void, PO: ObserverCtor | undefined): string | null {
  const type = ['long-animation-frame', 'longtask'].find((t) => PO?.supportedEntryTypes?.includes(t));
  if (!PO || !type) return null;
  new PO((list) => { for (const e of list.getEntries()) if (e.duration > LONG_MS) record(e.startTime, e.duration); }).observe({ type, buffered: true });
  return type;
}
