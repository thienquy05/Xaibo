// Status badge (design §3.1–§3.2, §4; P4-T01): lifecycle and evidence icons plus the spelled-out label, then reasons,
// each in its semantic foreground on the neutral background behind it. Icons are aria-hidden: the text says it all.
import type { LiveStatus } from '../../shared/ipc.ts';
import { ICONS, type IconId } from './icons.ts';
import { statusPresentation } from './presentation.ts';

export function Icon({ id }: { id: IconId }) {
  return (
    <svg className="x-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[id].map((s, i) => {
        if (s.kind === 'circle') return <circle key={i} cx={s.cx} cy={s.cy} r={s.r} />;
        if (s.kind === 'rect') return <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} className={s.fill ? 'x-fill' : s.dash ? 'x-dash' : undefined} />;
        return <path key={i} d={s.d} className={s.dash ? 'x-dash' : undefined} />;
      })}
    </svg>
  );
}

export function StatusBadge({ status }: { status: LiveStatus | null }) {
  const p = statusPresentation(status?.lifecycle ?? null, status?.confidence ?? null, status?.reason ? [status.reason] : []);
  return (
    <span className="x-status">
      <span className={`x-status-item x-tone-${p.tone}`}><Icon id={p.icon} /><Icon id={p.confidenceIcon} /><span>{p.label}</span></span>
      {p.reasons.map((r) => <span key={r.label} className={`x-status-item x-tone-${r.tone}`}> <Icon id={r.icon} /><span>{r.label}</span></span>)}
      {p.detail ? <span className="x-status-item x-tone-muted"> {p.detail}</span> : null}
    </span>
  );
}
