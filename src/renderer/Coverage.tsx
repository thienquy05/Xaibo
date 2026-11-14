// Service coverage banners (P3-T10, Q3-5 placeholder): hook-only gaps, disk full, hooks blocked by policy, awaiting
// trust with its steps; text plus glyph, every service-supplied string through visible() (EC-55). Hidden when empty.
import type { AgentStatus, Banner } from '../shared/ipc.ts';
import { bannerText } from './model.ts';
import { visible } from './text.ts';

export function Coverage({ banners, agents }: { banners: Banner[]; agents: AgentStatus[] | null }) {
  if (!banners.length) return null;
  const name = (id: string) => agents?.find((a) => a.agent === id)?.name ?? id;
  return (
    <section aria-label="Coverage">
      <h2>Coverage</h2>
      <ul>
        {banners.map((b, i) => (
          <li key={i}>
            <span aria-hidden="true">⚠</span> {bannerText(b, name)}
            {b.kind === 'awaiting-trust' && b.steps.length ? <ol>{b.steps.map((s, j) => <li key={j}>{visible(s)}</li>)}</ol> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
