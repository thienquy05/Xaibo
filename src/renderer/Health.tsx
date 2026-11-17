// Service health (P1-T06) and the agent status strip with "Set path…" (P1-T08), as text plus glyph. Logic and
// validation live in src/shared/ipc.ts, model.ts and text.ts.
import { READ_ONLY_BANNER } from '../shared/ipc.ts';
import type { AgentStatus, Banner, Health } from '../shared/ipc.ts';
import { bandText, type BandState } from './model.ts';
import { Icon } from './status/StatusBadge.tsx';
import type { IconId } from './status/icons.ts';
import { visible } from './text.ts';

// XAIBO-PROD-436 (D-P4-09): paused (disk full) takes the coverage banner's warning glyph and tone
const GLYPH: Record<BandState, IconId> = { starting: 'hourglass', running: 'link', restarting: 'restore', stopped: 'ended', paused: 'finding' };
const TONE: Record<BandState, string> = { starting: 'muted', running: 'success', restarting: 'warning', stopped: 'danger', paused: 'warning' };

export function HealthStatus({ health, banners }: { health: Health | null; banners: readonly Banner[] }) {
  const band = bandText(health, banners);
  return (
    <>
      <p role="status" aria-live="polite" className="x-band"><span className={`x-tone-${TONE[band.state]}`}><Icon id={GLYPH[band.state]} /></span> Collection: {band.text}</p>
      {health?.readOnly ? <p role="alert">{READ_ONLY_BANNER[health.readOnly]}</p> : null}
    </>
  );
}

export function AgentStrip({ agents, onSetPath }: { agents: AgentStatus[] | null; onSetPath: (agent: string) => void }) {
  return (
    <section aria-label="Agents" className="x-agents">
      <h2>Agents</h2>
      {agents === null ? <p>Detecting agents…</p> : agents.length === 0 ? <p>No agents detected</p> : (
        <ul>
          {agents.map((a) => (
            <li key={a.agent}>
              {visible(a.name)}: {a.state === 'detected' ? `Detected${a.version ? ` ${visible(a.version)}` : ''}` : 'Not detected'}{' '}
              <button type="button" className="x-button" aria-label={`Set path for ${visible(a.name)}`} onClick={() => onSetPath(a.agent)}>Set path…</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
