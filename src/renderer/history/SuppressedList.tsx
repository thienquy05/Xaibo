// XAIBO-PROD-536 (P5-T18 part 3b-7; design §6.4 Suppressed; look D-P5-09): the Suppressed mode's records, newest first,
// paged by the service's {at, key} cursor. Each record shows its suppression metadata only (suppressed.ts) and opens the
// metadata pane with Re-import; a record that left (Re-import) is removed here. Strings render as text (EC-55).
import { useEffect, useRef, useState } from 'react';
import type { ReimportResult, SuppressedCursor, SuppressedRow } from '../../shared/ipc.ts';
import { VirtualList } from '../components/VirtualList.tsx';
import { PAGE } from '../model.ts';
import { visible } from '../text.ts';
import { appendPage, newGone, recordName, suppressedLines } from './suppressed.ts';

export interface SuppressedApi {
  suppressed(cursor: SuppressedCursor | null, limit: number): Promise<{ rows: SuppressedRow[]; next: SuppressedCursor | null; failed?: true }>;
  reimport(key: string): Promise<ReimportResult>;
}
/** A Re-import outcome said beside the list heading; gone: the record left the list. */
export interface Gone { key: string; note: string; gone: boolean; n: number }
type State = { rows: SuppressedRow[]; next: SuppressedCursor | null; status: 'loading' | 'more' | 'ready' | 'failed'; failedMore: boolean };

// ponytail: loaded when the mode opens and never refreshed by service resyncs; reopening the mode reloads it. Resync it
// like the history list if suppressions start changing while it is shown (only Purge and Re-import change them).
export function SuppressedList({ api, openKey, gone, onOpen }: { api: SuppressedApi; openKey: string | null; gone: Gone | null; onOpen: (r: SuppressedRow) => void }) {
  const [s, setS] = useState<State>({ rows: [], next: null, status: 'loading', failedMore: false });
  const live = useRef(true);
  const removed = useRef(new Set<string>()); // review L1: a page requested before a Re-import never brings its record back
  const load = (cursor: SuppressedCursor | null) => {
    setS((x) => ({ ...x, status: cursor ? 'more' : 'loading', failedMore: false }));
    api.suppressed(cursor, PAGE).then((p) => {
      if (p.failed) throw new Error('suppressed failed');
      const rows = p.rows.filter((r) => !removed.current.has(r.key));
      if (live.current) setS((x) => ({ rows: cursor ? appendPage(x.rows, rows) : rows, next: p.next, status: 'ready', failedMore: false }));
    }).catch(() => { if (live.current) setS((x) => ({ ...x, status: 'failed', failedMore: cursor !== null })); });
  };
  useEffect(() => { live.current = true; load(null); return () => { live.current = false; }; }, []);
  const seenGone = useRef(gone?.n);
  useEffect(() => {
    if (!newGone(gone, seenGone.current)) return; // re-review M: never the value this list mounted with
    seenGone.current = gone?.n;
    if (!gone?.gone) return;
    removed.current.add(gone.key);
    setS((x) => ({ ...x, rows: x.rows.filter((r) => r.key !== gone.key) }));
  }, [gone]);

  const ready = s.status === 'ready' || s.status === 'more';
  return (
    <>
      <span className="x-sr-only" aria-live="polite">{ready ? `Suppressed: ${s.rows.length}${s.next ? ' or more' : ''} shown` : ''}</span>
      {s.status === 'failed' && s.rows.length === 0 ? (
        <p className="x-empty-note">The list could not be loaded. <button type="button" className="x-btn x-btn-quiet" onClick={() => load(null)}>Retry</button></p>
      ) : s.rows.length === 0 ? <p className="x-empty-note">{ready ? 'No suppressed sessions.' : 'Loading…'}</p> : (
        <VirtualList items={s.rows} getKey={(r) => r.key} label="Suppressed sessions" itemLabel={recordName} estimateSize={76}
          hasMore={s.next !== null} loading={s.status === 'more' || s.status === 'loading'} onLoadMore={() => { if (s.next && s.status === 'ready') load(s.next); }}
          render={(r) => {
            const l = suppressedLines(r);
            return (
              <button type="button" className="x-srow" data-key={r.key} aria-current={r.key === openKey || undefined} onClick={() => onOpen(r)}>
                <span className="x-s-title">{visible(l.title)}</span>
                <span className="x-s-meta">{l.lines.map((t) => <span key={t}>{t}</span>)}</span>
              </button>
            );
          }} />
      )}
      {s.status === 'failed' && s.rows.length > 0 ? (
        <p className="x-empty-note">{s.failedMore ? 'More records could not be loaded.' : 'The list could not be refreshed.'}{' '}
          <button type="button" className="x-btn x-btn-quiet" onClick={() => load(s.failedMore ? s.next : null)}>Retry</button></p>
      ) : null}
    </>
  );
}
