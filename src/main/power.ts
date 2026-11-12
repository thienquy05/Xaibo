// Power events to the service (P3-T12; EC-43, FR-02). Suspend carries main's clock at the event: the message may only be
// delivered once the machine wakes, and the status engine must exclude the sleep from the right start. Resume asks the
// service to wake (engine resume plus the bounded reconcile). No Electron import: main passes `powerMonitor`.
import { IPC_VERSION, type ServiceCommand } from '../shared/ipc.ts';

export function forwardPower(power: { on(event: 'suspend' | 'resume', fn: () => void): unknown }, send: (c: ServiceCommand) => void, now: () => number): void {
  power.on('suspend', () => send({ v: IPC_VERSION, type: 'suspend', at: now() }));
  power.on('resume', () => send({ v: IPC_VERSION, type: 'wake' }));
}
