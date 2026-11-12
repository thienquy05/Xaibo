// Service supervisor (P1-T06, ROB, §7.1): forks the service, restarts it after an unexpected exit with bounded
// exponential backoff (OQ-P1-07: 0.5 s doubling to a 30 s cap, retried indefinitely, the counter reset once the exited
// service had been ready for 60 s), brokers a fresh port per renderer connection, reports health, and stop() quits
// without restart. No Electron import: fork, channel, clock and timers are injected (main/index.ts passes Electron's).
import { accept, IPC_VERSION, parseServiceEvent } from '../shared/ipc.ts';
import type { Health, HealthState, ReadOnlyReason, ServiceCommand, ServiceEvent } from '../shared/ipc.ts';

export const HEALTHY_RESET_MS = 60_000;
export const nextDelay = (attempt: number) => Math.min(500 * 2 ** attempt, 30_000);

export interface Child<P> {
  postMessage(message: unknown, transfer?: P[]): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}
export interface SupervisorDeps<P> {
  fork(): Child<P>;
  channel(): { port1: P; port2: P };
  onHealth(h: Health): void;
  onSpawn?(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  now(): number;
  quitMs: number;
  log?(event: string, fields?: Record<string, number>): void;
  /** P3-T11: a validated notify intent from the service. */
  onNotify?(n: Extract<ServiceEvent, { type: 'notify' }>): void;
}

export class Supervisor<P> {
  readonly #d: SupervisorDeps<P>;
  readonly #receive = accept(parseServiceEvent, (m) => { if (m.type === 'ready') this.#ready(m.readOnly); else this.#d.onNotify?.(m); });
  #child: Child<P> | null = null;
  #attempt = 0;
  #readyAt: number | undefined;
  #readOnly: ReadOnlyReason | null = null;
  #timer: unknown;
  #stopping = false;
  #health: Health = { v: IPC_VERSION, type: 'health', state: 'starting', attempt: 0, readOnly: null };

  constructor(deps: SupervisorDeps<P>) { this.#d = deps; }

  get health(): Health { return this.#health; }
  get dropped(): number { return this.#receive.dropped; }

  start(): void {
    this.#set('starting', 0);
    this.#spawn();
  }

  send(cmd: ServiceCommand): void { this.#child?.postMessage(cmd); }

  /** A new channel: one end to the running service, the other returned for the renderer; null while none runs. */
  connect(): P | null {
    if (!this.#child) return null;
    const { port1, port2 } = this.#d.channel();
    this.#child.postMessage({ v: IPC_VERSION, type: 'port' }, [port1]);
    return port2;
  }

  /** Asks the service to quit, kills it after quitMs, never restarts it. */
  stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== undefined) this.#d.clearTimer(this.#timer);
    this.#timer = undefined;
    const child = this.#child;
    if (!child) { this.#set('stopped', 0); return Promise.resolve(); }
    return new Promise((resolve) => {
      const kill = this.#d.setTimer(() => child.kill(), this.#d.quitMs);
      child.on('exit', () => { this.#d.clearTimer(kill); this.#set('stopped', 0); resolve(); });
      child.postMessage({ v: IPC_VERSION, type: 'quit' });
    });
  }

  #spawn(): void {
    this.#timer = undefined;
    this.#readyAt = undefined;
    const child = this.#d.fork();
    this.#child = child;
    child.on('message', this.#receive); // only one child is alive at a time, so no sender check is needed
    child.on('exit', (code) => {
      this.#child = null;
      this.#d.log?.('service_exit', { code });
      if (this.#stopping) return;
      if (this.#readyAt !== undefined && this.#d.now() - this.#readyAt >= HEALTHY_RESET_MS) this.#attempt = 0;
      const delayMs = nextDelay(this.#attempt++);
      this.#set('restarting', this.#attempt);
      this.#d.log?.('service_restart', { attempt: this.#attempt, delayMs });
      this.#timer = this.#d.setTimer(() => this.#spawn(), delayMs);
    });
    this.#d.onSpawn?.();
  }

  #ready(readOnly: ReadOnlyReason | null): void {
    this.#readyAt = this.#d.now();
    this.#readOnly = readOnly;
    this.#d.log?.('service_ready', { readOnly: readOnly === null ? 0 : 1 });
    this.#set('running', 0);
  }

  #set(state: HealthState, attempt: number): void {
    this.#health = { v: IPC_VERSION, type: 'health', state, attempt, readOnly: this.#readOnly };
    this.#d.onHealth(this.#health);
  }
}
