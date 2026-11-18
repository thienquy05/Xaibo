// XAIBO-PROD-438 (D-P4-10; design §6.13 B3): a failure notice with its Retry. While the retry runs the button is
// disabled and reads Retrying… with the loading glyph; each new failure remounts the alert, so it is announced again.
import { failText, retryLabel, type Retry } from '../retry.ts';
import { Icon } from '../status/StatusBadge.tsx';

export function RetryNotice({ thing, retry, onRetry, verb = 'load', className = 'x-gap', alert = true }: {
  thing: string; retry: Retry; onRetry: () => void; verb?: 'load' | 'refresh'; className?: string;
  /** false where a polite live region already announces the failure (no double announcement) */
  alert?: boolean;
}) {
  return (
    // review HIGH: only the text remounts (and is announced) on a new failure; the button keeps its identity and focus
    <p className={className}>
      <Icon id="finding" /><span key={retry.failures} role={alert ? 'alert' : undefined}>{failText(thing, retry.failures, retry.at, verb)}</span>
      <button type="button" className="x-btn x-btn-secondary" aria-disabled={retry.busy || undefined} aria-busy={retry.busy || undefined}
        onClick={() => { if (!retry.busy) onRetry(); }}>
        {retry.busy ? <Icon id="loading" /> : null}{retryLabel(retry.busy)}
      </button>
    </p>
  );
}

/** A Loading line: the loading glyph, then its words (design §6.13 B2 as amended by D-P4-10). */
export function LoadingLine({ text, className = 'x-earlier' }: { text: string; className?: string }) {
  return <p className={`${className} x-loading-line`}><Icon id="loading" />{text}</p>;
}
