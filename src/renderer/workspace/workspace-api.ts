// XAIBO-PROD-454 (G4a-1 follow-up): the Session workspace's page requests, sent to whichever client is current (a service
// restart brings a new one). Every argument is forwarded as given, so slice's optional tool call selector reaches IPC.
import type { Client } from '../client.ts';

export type WorkspaceApi = Pick<Client, 'session' | 'transcript' | 'slice' | 'tools' | 'subagents' | 'files' | 'markers' | 'cost'>;

export function workspaceApiOf(get: () => Client | null): WorkspaceApi {
  const c = () => get() ?? (() => { throw new Error('no service'); })();
  return {
    session: async (...a) => c().session(...a),
    transcript: async (...a) => c().transcript(...a),
    slice: async (...a) => c().slice(...a),
    tools: async (...a) => c().tools(...a),
    subagents: async (...a) => c().subagents(...a),
    files: async (...a) => c().files(...a),
    markers: async (...a) => c().markers(...a),
    cost: async (...a) => c().cost(...a),
  };
}
