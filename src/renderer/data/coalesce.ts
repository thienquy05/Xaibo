// Live-delta coalescer (P4-T02; S-29, M4/M12): the latest value per key, applied at most once per animation frame.
// Bounded by distinct keys: a frame with more than `max` keys drops its batch and asks for one cursor resync, so memory
// stays bounded and the final state still comes from the store (never lost).
export interface CoalescerOptions<V> {
  max: number;
  schedule: (cb: () => void) => void;
  flush: (values: V[], tags: number[]) => void;
  resync: () => void;
}

const MAX_TAGS = 64; // perf-trace delta ids only (XAIBO_PERF_TRACE=1); beyond this a frame acks fewer ids

export function createCoalescer<V>(o: CoalescerOptions<V>) {
  let pending = new Map<number, V>();
  let tags: number[] = [];
  let overflowed = false;
  let scheduled = false;
  const run = () => {
    scheduled = false;
    if (overflowed) { overflowed = false; o.resync(); return; }
    const values = [...pending.values()];
    const t = tags;
    pending = new Map();
    tags = [];
    if (values.length) o.flush(values, t);
  };
  return {
    push(key: number, value: V, tag?: number): void {
      if (!overflowed) {
        if (!pending.has(key) && pending.size >= o.max) { overflowed = true; pending = new Map(); tags = []; }
        else {
          pending.delete(key); // re-insert keeps the newest at the end
          pending.set(key, value);
          if (tag !== undefined && tags.length < MAX_TAGS) tags.push(tag);
        }
      }
      if (!scheduled) { scheduled = true; o.schedule(run); }
    },
    get size(): number { return pending.size; },
  };
}
