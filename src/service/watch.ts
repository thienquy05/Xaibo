// Change detection (P1-T10, S12 strategy; FR-02, EC-18, EC-19): a stat-only reconciliation scan every interval
// finds new and changed files and never reads unchanged ones; recently active files also get their own fs.watch
// under an FD cap; a failing watch just leaves that file to the scan; wake() reconciles at once.
import { watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';

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
  readonly #watchers = new Map<string, Closable>();
  #timer: NodeJS.Timeout | undefined;
  #scan: Promise<void> | undefined;

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
    clearInterval(this.#timer);
    for (const w of this.#watchers.values()) w.close();
    this.#watchers.clear();
  }

  scan(): Promise<void> { return this.#run(false); }

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
      try { st = await stat(e.path); } catch { continue; }
      const prev = this.#seen.get(e.path);
      this.#seen.set(e.path, { size: st.size, mtime: st.mtimeMs, ino: st.ino });
      if (!initial && (!prev || prev.size !== st.size || prev.mtime !== st.mtimeMs || prev.ino !== st.ino)) this.#o.onChange(e);
      this.#manageWatch(e, this.#o.now() - st.mtimeMs < this.#o.activeMs);
    }
    for (const path of [...this.#seen.keys()]) if (!present.has(path)) { this.#seen.delete(path); this.#unwatch(path); }
  }

  #manageWatch(e: E, active: boolean): void {
    if (!active) return this.#unwatch(e.path); // inactive handles close
    if (this.#watchers.has(e.path) || this.#watchers.size >= this.#o.maxWatched) return;
    try {
      const w = this.#o.watch(e.path, () => this.#o.onChange(e));
      w.on('error', () => this.#unwatch(e.path)); // the scan keeps covering it
      this.#watchers.set(e.path, w);
    } catch { /* EMFILE, ENOSPC, unsupported fs: the scan covers this file */ }
  }

  #unwatch(path: string): void {
    this.#watchers.get(path)?.close();
    this.#watchers.delete(path);
  }
}
