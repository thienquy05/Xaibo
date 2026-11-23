// XAIBO-PROD-558 (P6-T03 part 1b; design: Codex §1-2 and the part 1b review in .handoff/p6-t03-design.md): the Connect IPC
// over the part 1a core. Requests carry a profile id, selections or a preview id only (parsePortRequest); a preview belongs
// to the port that asked. Every request gets a reply: read-only and starting refusals first, any throw becomes `failed`.
// Replies pass the shared bound check (parseConnectReply): an over-bound one is refused as too-large, never truncated, and
// the retention offer goes out without its ops.
import os from 'node:os';
import path from 'node:path';
import { IPC_VERSION, parseConnectReply, type ConnectReply, type PortMessage, type PortRequest } from '../shared/ipc.ts';
import { CLAUDE_MANAGED_DIR } from './adapters/claude/hooks.ts';
import type { LoginEnv } from './catalog/env.ts';
import type { Profile } from './catalog/detect.ts';
import type { RetentionOffer } from './catalog/setup-plans.ts';
import { deniedRootsFrom, real } from './config/bounds.ts';
import type { ConnectContext, createConnect } from './integrations/connect.ts';

export type Connect = ReturnType<typeof createConnect>;
export type IntegrationsRequest = Extract<PortRequest, { type: 'connectPreview' | 'connectApply' | 'disconnect' | 'uninstall' }>;
export interface IntegrationsDeps {
  /** The store refused writes (a newer schema may own the manifest): every request is refused. */
  readOnly: boolean;
  /** Read inside the reply guard (review L-1): null until profiles are synced (`starting`); 'unavailable' when startup ended
   *  without a profile sync (review L-2). */
  connect: () => Connect | null | 'unavailable';
  /** The live synced profiles by id (never the DB table, which may keep old roots). */
  profile: (id: string) => Profile | undefined;
}

const REPO = path.resolve(import.meta.dirname, '..', '..'); // src/service or out/service; never the cwd
/** The service's Connect context. `bin` is main's XAIBO_BIN: the packaged resources/bin, or '' for the repo's helpers. */
export function connectContext(o: { dataDir: string; login: LoginEnv | null; bin: string }): ConnectContext {
  const helpers = o.bin
    ? { hook: path.join(o.bin, 'xaibo-hook'), forwarder: path.join(o.bin, 'xaibo-forwarder'), statusline: path.join(o.bin, 'xaibo-statusline') }
    : { hook: path.join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder: path.join(REPO, '.cache', 'sea', 'xaibo-forwarder'), statusline: path.join(REPO, '.cache', 'sea', 'xaibo-statusline') };
  // the packaged build keeps the temp dir only for the isolated E2E profiles (review L6); resolved once
  const allowed = [real(os.tmpdir()), ...(o.bin ? [] : [path.join(REPO, '.cache', 'profiles')])];
  return { dataDir: o.dataDir, denied: o.login ? deniedRootsFrom(o.login) : null, allowed, claudeManagedDir: CLAUDE_MANAGED_DIR, helpers };
}

const refused = (code: string): ConnectReply => ({ status: 'refused', code });
const offer = (o: RetentionOffer | null) => (o === null ? null : o.offered ? { offered: true, from: o.from, to: o.to, layer: o.layer } : { offered: false, reason: o.reason, days: o.days });
/** The wire shape (no ops) through the shared bound check. */
function wire(r: unknown, wrote: boolean): ConnectReply {
  const shape = (x: Record<string, unknown>): Record<string, unknown> =>
    (x['status'] === 'preview' ? { ...x, retention: offer(x['retention'] as RetentionOffer | null) } : x['status'] === 'needs-preview' ? { ...x, preview: shape(x['preview'] as Record<string, unknown>) } : x);
  // review M-1: after apply, disconnect or uninstall something may have changed: never "refused", say partial and re-read
  return parseConnectReply(shape(r as Record<string, unknown>))
    ?? (wrote ? { status: 'partial', reverted: [], conflicts: [], remaining: [], code: 'too-large' } : refused('too-large'));
}

export function answerIntegrations(d: IntegrationsDeps, req: IntegrationsRequest, owner: object): PortMessage {
  const send = (result: ConnectReply): PortMessage => ({ v: IPC_VERSION, type: req.type, id: req.id, result });
  if (d.readOnly) return send(refused('read-only'));
  try {
    const c = d.connect();
    if (c === null) return send(refused('starting'));
    if (c === 'unavailable') return send(refused('unavailable'));
    if (req.type === 'connectApply') return send(wire(c.applyConnect(req.previewId, owner), true));
    if (req.type === 'uninstall') return send(wire(c.uninstall(), true));
    const p = d.profile(req.profileId);
    if (!p) return send(refused('profile-not-found'));
    return send(req.type === 'connectPreview' ? wire(c.previewConnect(p, req.selections, owner), false) : wire(c.disconnect(p), true));
  } catch { return send(refused('failed')); } // never an unanswered request (review M2); never the error text
}
