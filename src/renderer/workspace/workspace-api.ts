// XAIBO-PROD-454 (G4a-1 follow-up): the Session workspace's page requests, sent to whichever client is current (a service
// restart brings a new one). Every argument is forwarded as given, so slice's optional tool call selector reaches IPC.
import type { Client } from '../client.ts';

const METHODS = ['session', 'transcript', 'slice', 'tools', 'subagents', 'files', 'markers', 'cost', 'historyRow', 'overlay', 'purge', 'projects', 'folders'] as const; // XAIBO-PROD-533/534/535: Keep, retention, Trash, Move
export type WorkspaceApi = Pick<Client, (typeof METHODS)[number]>;

export function workspaceApiOf(get: () => Client | null): WorkspaceApi {
  return Object.fromEntries(METHODS.map((k) => [k, async (...a: unknown[]) => {
    const c = get();
    if (!c) throw new Error('no service');
    return (c[k] as (...args: unknown[]) => Promise<unknown>)(...a);
  }])) as WorkspaceApi;
}
