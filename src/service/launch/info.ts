// XAIBO-PROD-621 (P7-T04 slice B; design §6.7): what main's launch flow needs from the service, per catalog agent: its display
// name, detected version, the executable as found (P7-T02 checks the found name against the catalog's names and resolves it
// itself; the P7-T03 grant binds the realpath and bytes), the catalog's executable names, the bundled launch template or the
// disabled reason (launch-templates.ts), and the agent's profiles with a display label. Main only (never a renderer port).
// Pure: the service passes its live catalog, detections and profiles.
import path from 'node:path';
import type { LaunchAgentInfo } from '../../shared/ipc.ts';
import type { Detection, Profile } from '../catalog/detect.ts';
import { launchTemplate } from '../catalog/launch-templates.ts';
import type { Catalog } from '../catalog/validate.ts';

const label = (p: Profile, home: string) => (p.origin === 'default' ? 'Default profile'
  : p.root === home || p.root.startsWith(`${home}${path.sep}`) ? `~${p.root.slice(home.length)}` : p.root);

export function launchInfo(catalog: Catalog | null, detections: readonly Detection[], profiles: readonly Profile[] | null, home: string): LaunchAgentInfo[] {
  return (catalog?.agents ?? []).map((a) => {
    const d = detections.find((x) => x.agent === a.id);
    return {
      agent: a.id, name: a.displayName,
      version: d?.state === 'detected' ? d.version : null,
      executable: d?.state === 'detected' ? d.found ?? d.path : null,
      names: a.detection.binaries.flatMap((b) => b.names),
      launch: launchTemplate(catalog!, a.id),
      profiles: (profiles ?? []).filter((p) => p.agent === a.id).map((p) => ({ id: p.id, label: label(p, home) })),
    };
  });
}
