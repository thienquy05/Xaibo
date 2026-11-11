// The renderer's side of the brokered service port (P1-T12): numbered requests, each resolved only by its own reply;
// pushed deltas and agent status go to their handlers; every message is validated (src/shared/ipc.ts) and invalid ones
// are counted; an invalid reply rejects its request, so the caller can recover. A service restart brings a new port
// and a new client; replies owed on the old one never arrive.
import { accept, IPC_VERSION, parsePortMessage } from '../shared/ipc.ts';
import type { AgentStatus, Cursor, Page, PortRequest, SessionRow } from '../shared/ipc.ts';

export interface PortLike { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void; close(): void }
export interface Pushes { sessions(rows: SessionRow[]): void; agents(agents: AgentStatus[] | null): void }

export function createClient(port: PortLike, push: Pushes) {
  let nextId = 1;
  const pending = new Map<number, { resolve: (p: Page) => void; reject: (e: Error) => void }>();
  const receive = accept(parsePortMessage, (m) => {
    if (m.type === 'page') {
      pending.get(m.id)?.resolve({ rows: m.rows, next: m.next });
      pending.delete(m.id);
    } else if (m.type === 'sessions') push.sessions(m.rows);
    else push.agents(m.agents);
  });
  port.onmessage = (e) => {
    const dropped = receive.dropped;
    receive(e.data);
    const m = e.data as { type?: unknown; id?: unknown } | null;
    if (receive.dropped !== dropped && m?.type === 'page' && typeof m.id === 'number') {
      pending.get(m.id)?.reject(new Error('invalid reply'));
      pending.delete(m.id);
    }
  };
  return {
    listSessions(cursor: Cursor | null, limit: number): Promise<Page> {
      const req: PortRequest = { v: IPC_VERSION, type: 'listSessions', id: nextId++, cursor, limit };
      return new Promise((resolve, reject) => { pending.set(req.id, { resolve, reject }); port.postMessage(req); });
    },
    get dropped() { return receive.dropped; },
    close() { port.onmessage = null; pending.clear(); port.close(); },
  };
}
export type Client = ReturnType<typeof createClient>;
