// Service health (P1-T06) and the agent status strip with "Set path…" (P1-T08), as text plus glyph. Logic and
// validation live in src/shared/ipc.ts and text.ts.
import { healthText, READ_ONLY_BANNER } from '../shared/ipc.ts';
import type { AgentStatus, Health, HealthState } from '../shared/ipc.ts';
import { visible } from './text.ts';

const GLYPH: Record<HealthState, string> = { starting: '◌', running: '●', restarting: '↻', stopped: '■' };

export function HealthStatus({ health }: { health: Health | null }) {
  const state = health?.state ?? 'starting';
  return (
    <>
      <p role="status" aria-live="polite"><span aria-hidden="true">{GLYPH[state]}</span> Service: {health ? healthText(health) : 'Starting'}</p>
      {health?.readOnly ? <p role="alert">{READ_ONLY_BANNER[health.readOnly]}</p> : null}
    </>
  );
}

export function AgentStrip({ agents, onSetPath }: { agents: AgentStatus[] | null; onSetPath: (agent: string) => void }) {
  return (
    <section aria-label="Agents">
      <h2>Agents</h2>
      {agents === null ? <p>Detecting agents…</p> : (
        <ul>
          {agents.map((a) => (
            <li key={a.agent}>
              {visible(a.name)}: {a.state === 'detected' ? `Detected${a.version ? ` ${visible(a.version)}` : ''}` : 'Not detected'}{' '}
              <button type="button" aria-label={`Set path for ${visible(a.name)}`} onClick={() => onSetPath(a.agent)}>Set path…</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
