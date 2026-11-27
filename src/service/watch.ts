// Change detection (P1-T10, S12 strategy; FR-02, EC-18, EC-19): a stat-only reconciliation scan every interval
// finds new and changed files and never reads unchanged ones; recently active files also get their own fs.watch
// under an FD cap; a failing watch just leaves that file to the scan; wake() reconciles at once.
import { watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { counters } from './perf-counters.ts';

export interface Closable { close(): void; on(event: 'error', fn: () => void): unknown }
export type WatchFn = (path: string, listener: () => void) => Closable;

export interface WatcherOptions<E extends { path: string }> {
  list: () => Promise<E[]>;
  onChange: (entry: E) => void;
  intervalMs?: number; // reconciliation interval (S12 default 5 s, Q8)
  activeMs?: number; // a file modified within this window gets its own watch
  maxWatched?: number; // FD cap
  watch?: WatchFn;
  now?: () => number;
}

interface Seen { size: number; mtime: number; ino: number }

export class Watcher<E extends { path: string }> {
  readonly #o: Required<WatcherOptions<E>>;
  readonly #seen = new Map<string, Seen>();
  readonly #watchers = new Map<string, { w: Closable; mtime: number; ino: number }>();
  #timer: NodeJS.Timeout | undefined;
  #scan: Promise<void> | undefined;
  #stopped = false; // one-way: an adapter is never restarted after stop

  constructor(o: WatcherOptions<E>) {
    this.#o = {
      intervalMs: 5000, activeMs: 10 * 60_000, maxWatched: 200, now: Date.now,
      watch: (p, fn) => fsWatch(p, { persistent: false }, fn), ...o,
    };
  }

  /** Records the current state without reporting it (the caller backfills), then starts the interval. */
  async start(): Promise<void> {
    await this.#run(true);
    this.#timer = setInterval(() => void this.scan(), this.#o.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true; // review M: a scan already running opens no watch after this
    clearInterval(this.#timer);
    for (const x of this.#watchers.values()) x.w.close();
    this.#watchers.clear();
  }

  scan(): Promise<void> { return this.#run(false); }

  /** Open fs.watch handles (P4-T10 metrics); never above maxWatched. */
  watched(): number { return this.#watchers.size; }

  /** Drops what was seen of a file, so the next scan reports it again (a failed sync is retried). */
  forget(path: string): void { this.#seen.delete(path); }

  #run(initial: boolean): Promise<void> {
    // One scan at a time; a call during a scan waits for it and then runs once more.
    const next = (this.#scan ?? Promise.resolve()).then(() => this.#pass(initial));
    this.#scan = next.catch(() => undefined);
    return next;
  }

  async #pass(initial: boolean): Promise<void> {
    const entries = await this.#o.list();
    const present = new Set<string>();
    for (const e of entries) {
      present.add(e.path);
      let st;
      try { st = await stat(e.path); } catch { this.#seen.delete(e.path); this.#unwatch(e.path); continue; } // gone since listing, or unreadable (EC-71; any errno: the next good scan re-reports it from its checkpoint)
      const prev = this.#seen.get(e.path);
      this.#seen.set(e.path, { size: st.size, mtime: st.mtimeMs, ino: st.ino });
      if (!initial && (!prev || prev.size !== st.size || prev.mtime !== st.mtimeMs || prev.ino !== st.ino)) { counters.scanChanges++; this.#o.onChange(e); }
      this.#manageWatch(e, this.#o.now() - st.mtimeMs < this.#o.activeMs, st.mtimeMs, st.ino);
    }
    // EC-71: a forgotten path (failed sync) has no seen entry but may still hold a watch, so both maps are swept
    for (const path of new Set([...this.#seen.keys(), ...this.#watchers.keys()])) if (!present.has(path)) { this.#seen.delete(path); this.#unwatch(path); }
  }

  #manageWatch(e: E, active: boolean, mtime: number, ino: number): void {
    if (!active || this.#stopped) return this.#unwatch(e.path); // inactive handles close
    const held = this.#watchers.get(e.path);
    // EC-71: a watch follows the inode, so a file replaced at the same path drops the handle on the dead file
    if (held && held.ino !== ino) this.#unwatch(e.path);
    else if (held) { held.mtime = Math.max(held.mtime, mtime); return; } // activity only moves forward (a watch event may be newer)
    // P4-T10a (S12): at the FD cap the least recently active watched file gives way to a more recent one; an older or
    // equally recent file stays to the scan (no churn). ponytail: an O(cap) scan for the oldest per new active file;
    // keep a heap if the cap grows far past S12's ~200.
    if (this.#watchers.size >= this.#o.maxWatched) {
      let oldest: [string, number] | undefined;
      for (const [p, x] of this.#watchers) if (!oldest || x.mtime < oldest[1]) oldest = [p, x.mtime];
      if (!oldest || oldest[1] >= mtime) return;
      this.#unwatch(oldest[0]);
    }
    // ponytail: the victim is closed before the new watch opens (never above the cap); if that open fails, both files
    // are left to the scan until the next one.
    try {
      const held = { w: undefined as unknown as Closable, mtime, ino };
      held.w = this.#o.watch(e.path, () => {
        held.mtime = Math.max(held.mtime, this.#o.now()); // review M2: a change through the watch is fresh activity
        counters.watchChanges++; // XAIBO-PROD-552 (perf trace only)
        this.#o.onChange(e);
      });
      held.w.on('error', () => { if (this.#watchers.get(e.path) === held) this.#unwatch(e.path); }); // review L3: only this handle
      this.#watchers.set(e.path, held);
    } catch { /* EMFILE, ENOSPC, unsupported fs: the scan covers this file */ }
  }

  #unwatch(path: string): void {
    this.#watchers.get(path)?.w.close();
    this.#watchers.delete(path);
  }
}
