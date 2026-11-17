// XAIBO-PROD-413 (P4-T05d; design §6.3 as amended by D-P4-06): the open session's section bodies. Untrusted text is
// React text through visible(), in pre-wrap blocks; tool inputs/results and reasoning stay collapsed and are fetched as
// bounded slices only when expanded (design §5.2).
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { FileItem, ModelMarker, SubagentItem, ToolItem, TranscriptItem } from '../../shared/ipc.ts';
import { VirtualList } from '../components/VirtualList.tsx';
import { Icon } from '../status/StatusBadge.tsx';
import { visible, visibleBlock } from '../text.ts';
import { appendSlice, focusAfter, openWindow, prependSlice, previousAt, sliceAnnouncement, type SliceDir } from './slice.ts';
import { approvalText, durationLabel, FILE_KIND_TEXT, groupFiles, lifecycleText, resultText, toolTitle, type Entry } from './timeline.ts';
import { argFor, clock, isoTime, sizeText, toolMeta, toolTone } from './view.ts';

/** Fetches one bounded slice of an item's text or reasoning. */
export type SliceFn = (event: number, part: 'text' | 'reasoning', offset: number) => Promise<{ text: string; next: number | null }>;
export interface Paged<T> { items: T[]; more: boolean; loading: boolean; failed: boolean; loadMore: () => void }

/** Text of one item, as slices fetched on demand (design §5.2): at most MAX_SLICES stay in memory and in the DOM; past
 *  that the earliest is evicted and Load previous brings it back (slice.ts). Cursors are the service's, opaque here. */
function Slices({ event, part, slice, start = '', from = 0, label }: { event: number; part: 'text' | 'reasoning'; slice: SliceFn; start?: string; from?: number | null; label?: string }) {
  const [win, setWin] = useState(() => openWindow(start, from));
  const [busy, setBusy] = useState<SliceDir | null>(null);
  const [failed, setFailed] = useState<SliceDir | null>(null);
  const [said, setSaid] = useState(''); // XAIBO-PROD-435: the live region's text
  const inFlight = useRef(false); // XAIBO-PROD-435: a same-tick double activation or StrictMode remount fetches once
  const moved = useRef<SliceDir | null>(null); // the direction just loaded: focus follows if its button unmounted
  const textRef = useRef<HTMLElement>(null);
  /** `focused`: started from its button while that button had focus (only then may focus follow the text). */
  const load = (dir: SliceDir, focused = false) => {
    const at = dir === 'next' ? win.next : previousAt(win);
    // review M: the ref covers the same tick, `busy` the time until the render that brings the new window
    if (at === null || busy !== null || inFlight.current) return;
    inFlight.current = true;
    setBusy(dir);
    setSaid(sliceAnnouncement('loading', dir));
    slice(event, part, at).then((s) => {
      setWin((w) => (dir === 'next' ? appendSlice(w, at, s) : prependSlice(w, at, s)));
      setFailed(null);
      setSaid(sliceAnnouncement('loaded', dir));
      if (focused) moved.current = dir; // review L: never for the mount auto-load or a click that left focus elsewhere
    }, () => { setFailed(dir); setSaid(sliceAnnouncement('failed', dir)); }).finally(() => { inFlight.current = false; setBusy(null); });
  };
  // An expanded input, result or reasoning fetches its first slice at once (it mounts only when opened).
  useEffect(() => { if (start === '') load('next'); }, []); // once on mount
  // XAIBO-PROD-435: a button that unmounted after its load took focus with it; the text receives it instead of the body
  useEffect(() => {
    const dir = moved.current;
    moved.current = null;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (dir && lost && focusAfter(win, dir) === 'text') textRef.current?.focus();
  }, [win]);
  const label2 = (dir: 'next' | 'prev', idle: string) => (failed === dir ? 'Retry loading text' : busy === dir ? 'Loading text' : idle);
  return (
    <>
      {label ? <span className="x-label">{label}</span> : null}
      {previousAt(win) !== null ? (
        <button type="button" className="x-btn x-btn-secondary" aria-disabled={busy !== null || undefined} onClick={(e) => load('prev', document.activeElement === e.currentTarget)}>{label2('prev', 'Load previous')}</button>
      ) : null}
      {win.slices.length ? <pre className="x-code" ref={textRef as RefObject<HTMLPreElement>} tabIndex={-1}>{win.slices.map((s) => <span key={s.at}>{visibleBlock(s.text)}</span>)}</pre>
        : win.next === null ? <p className="x-label" ref={textRef as RefObject<HTMLParagraphElement>} tabIndex={-1}>No text recorded</p> : null}
      <span className="x-sr-only" aria-live="polite">{said}</span>
      {win.next !== null ? (
        <p className="x-more-row">
          {win.slices.length ? <span className="x-label">More content available</span> : null}
          <button type="button" className="x-btn x-btn-secondary" aria-disabled={busy !== null || undefined} onClick={(e) => load('next', document.activeElement === e.currentTarget)}>
            {label2('next', win.slices.length ? 'Load more text' : 'Load text')}
          </button>
        </p>
      ) : null}
    </>
  );
}

/** A message body: the service preview, then "Show more" fetches the rest from the preview's end. */
function MessageText({ item, slice }: { item: TranscriptItem; slice: SliceFn }) {
  const preview = item.preview ?? '';
  const [open, setOpen] = useState(false);
  if (!open || preview.length >= item.length) {
    return (
      <>
        <p className="x-text">{visibleBlock(preview)}</p>
        {preview.length < item.length ? <button type="button" className="x-btn x-btn-quiet x-more" onClick={() => setOpen(true)}>Show more</button> : null}
      </>
    );
  }
  return <div className="x-long"><Slices event={item.event} part="text" slice={slice} start={preview} from={preview.length} /></div>;
}

/** A compact, terminal-like row that expands in place; the body mounts (and fetches) only when opened. */
function Step({ lead, name, arg, meta, quiet = false, children }: { lead: ReactNode; name: string; arg?: string | null; meta: ReactNode; quiet?: boolean; children?: (open: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={`x-step${quiet ? ' x-step-quiet' : ''}`} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{lead}<span className="x-step-name">{name}</span>{arg ? <span className="x-step-arg">{visible(arg)}</span> : null}<span className="x-step-meta">{meta}</span></summary>
      {open && children ? <div className="x-step-out">{children(open)}</div> : null}
    </details>
  );
}
const Dot = ({ tone }: { tone: string }) => <span className={`x-dot x-dot-${tone}`} aria-hidden="true" />;

function ToolStep({ tool, item, touches, slice }: { tool: ToolItem | null; item: TranscriptItem | null; touches: FileItem[]; slice: SliceFn }) {
  const tone = toolTone(tool);
  const meta = toolMeta(tool);
  // Review L8: the call's own sliceable args event; a call item only when no tool record is loaded.
  const args = tool ? tool.argsEvent : item?.kind === 'tool-call' ? item.event : null;
  const result = tool?.resultEvent ?? (item?.kind === 'tool-result' ? item.event : null);
  return (
    <Step
      lead={<Dot tone={tone} />} name={tool?.tool ? visible(tool.tool) : item?.kind === 'tool-result' && !tool ? 'Tool result' : 'Unknown tool'}
      arg={argFor(tool?.callId ?? item?.callId ?? null, touches)}
      meta={<>{meta.map((m) => <span key={m} className={m === 'Approval requested' ? 'x-warn' : m === 'Denied' ? 'x-bad' : undefined}>{m}</span>)}<span className="x-sr-only">{toolTitle({ tool: tool?.tool ? visible(tool.tool) : null })}</span></>}
    >
      {() => (
        <>
          {args !== null ? <Slices event={args} part="text" slice={slice} label="Input" /> : <span className="x-label">Input unavailable from this source</span>}
          {result !== null ? <Slices event={result} part="text" slice={slice} label={`Result · ${tool ? resultText(tool) : 'Result recorded'}`} />
            : <span className="x-label">{tool ? resultText(tool) : 'Result unavailable'}</span>}
        </>
      )}
    </Step>
  );
}

function SubagentStep({ s }: { s: SubagentItem }) {
  return <Step lead={<Icon id="branch" />} name="Subagent" arg={s.agentType ?? s.nativeId}
    meta={<><span>{visible(s.model)}</span><span>{lifecycleText(s.lifecycle)}</span><span>{s.records} record{s.records === 1 ? '' : 's'}</span></>} />;
}

/** HH:MM text; a <time> with the exact instant when it is known (P4-T08b: a switch marker carries its time). */
function When({ ms }: { ms: number | null }) {
  const iso = isoTime(ms);
  return iso ? <time dateTime={iso}>{clock(ms)}</time> : <>{clock(ms)}</>;
}

const Marker = ({ icon, children }: { icon: 'information' | 'settle' | 'error'; children: ReactNode }) => <p className="x-marker"><Icon id={icon} />{children}</p>;

/** One Conversation entry (chat/terminal geometry, D-P4-06). */
function ConversationEntry({ e, touches, slice }: { e: Entry; touches: FileItem[]; slice: SliceFn }) {
  switch (e.kind) {
    case 'prompt':
      return <div className="x-prompt"><div className="x-who"><strong>Owner prompt</strong><span>{clock(e.item.ts)}</span></div><div className="x-bubble"><MessageText item={e.item} slice={slice} /></div></div>;
    case 'response':
      return (
        <div className="x-reply">
          <div className="x-who"><strong>Agent response</strong><span>{clock(e.item.ts)}</span></div>
          {e.item.reasoning ? (
            <div className="x-steps">
              <Step lead={<Icon id="chevron" />} name="Available reasoning" quiet meta={null}>{() => <Slices event={e.item.event} part="reasoning" slice={slice} />}</Step>
            </div>
          ) : null}
          {e.item.length > 0 ? <MessageText item={e.item} slice={slice} /> : null}
        </div>
      );
    case 'tool':
    case 'tool-result':
      return <div className="x-steps"><ToolStep tool={e.kind === 'tool' ? e.tool : null} item={e.item} touches={touches} slice={slice} /></div>;
    case 'large': // P4-T09a: a record above the parse cap; its text loads in bounded slices only when expanded
      return <div className="x-steps"><Step lead={<Icon id="chevron" />} name="Large record" meta={<><span>{e.item.length > 0 ? sizeText(e.item.length) : 'No readable text'}</span><span>{clock(e.item.ts)}</span></>}>
        {() => <Slices event={e.item.event} part="text" slice={slice} />}</Step></div>;
    case 'compaction': return <Marker icon="settle">Compaction · {clock(e.item.ts)}</Marker>;
    case 'interrupted': return <Marker icon="error">Interrupted · {clock(e.item.ts)}</Marker>;
    case 'model': return <Marker icon="information">Model {visible(e.marker.model)} · <When ms={e.marker.ts} /></Marker>;
    case 'subagent-start': return <div className="x-steps"><SubagentStep s={e.subagent} /></div>;
    case 'subagent-end': return <Marker icon="information">Subagent ended · {visible(e.subagent.agentType ?? e.subagent.nativeId)} · {clock(e.subagent.end)}</Marker>;
  }
}

const keyOf = (e: Entry) => e.key;
export function Conversation({ entries, touches, slice, gaps, prev, onPrev, next, onNext, loading }: {
  entries: Entry[]; touches: FileItem[]; slice: SliceFn; gaps: string[]; prev: boolean; onPrev: () => void; next: boolean; onNext: () => void; loading: boolean;
}) {
  return (
    <div className="x-section-list">
      {gaps.length ? <p className="x-gap"><Icon id="finding" /><span><strong>Content incomplete</strong> · {gaps.join('; ')}</span></p> : null}
      {prev ? <p className="x-earlier">More records before these <button type="button" className="x-btn x-btn-secondary" aria-disabled={loading || undefined} onClick={() => { if (!loading) onPrev(); }}>Load earlier</button></p> : null}
      {entries.length === 0 && !loading ? <p className="x-empty-note">No conversation records in this range.</p> : null}
      <VirtualList items={entries} getKey={keyOf} label="Conversation" estimateSize={72} hasMore={next} loading={loading} onLoadMore={onNext}
        render={(e) => <ConversationEntry e={e} touches={touches} slice={slice} />} />
    </div>
  );
}

function ledgerOf(e: Entry): { icon: Parameters<typeof Icon>[0]['id']; tone?: string; title: string; detail?: string; ts: number | null } {
  switch (e.kind) {
    case 'prompt': return { icon: 'session', title: 'Owner prompt', detail: e.item.preview ? visible(e.item.preview) : undefined, ts: e.item.ts };
    case 'response': return { icon: 'session', title: 'Agent response', detail: e.item.reasoning ? 'Available reasoning' : undefined, ts: e.item.ts };
    case 'tool': {
      const t = e.tool;
      return { icon: 'check', tone: toolTone(t), title: toolTitle({ tool: t?.tool ? visible(t.tool) : null }),
        detail: t ? [approvalText(t.approval), durationLabel(t.durationMs), resultText(t), t.sources.map(visible).join(', ')].join(' · ') : undefined, ts: e.item?.ts ?? t?.ts ?? null };
    }
    case 'tool-result': return { icon: 'check', title: 'Tool result', ts: e.item.ts };
    case 'large': return { icon: 'session', title: 'Large record', detail: e.item.length > 0 ? sizeText(e.item.length) : 'No readable text', ts: e.item.ts };
    case 'compaction': return { icon: 'settle', title: 'Compaction', ts: e.item.ts };
    case 'interrupted': return { icon: 'error', title: 'Interrupted', ts: e.item.ts };
    case 'model': return { icon: 'information', title: `Model ${visible(e.marker.model)}`, ts: e.marker.ts };
    case 'subagent-start': return { icon: 'branch', title: `Subagent started · ${visible(e.subagent.agentType ?? e.subagent.nativeId)}`, detail: visible(e.subagent.model), ts: e.subagent.start };
    case 'subagent-end': return { icon: 'branch', title: `Subagent ended · ${visible(e.subagent.agentType ?? e.subagent.nativeId)}`, ts: e.subagent.end };
  }
}
export function Timeline({ entries, next, onNext, loading }: { entries: Entry[]; next: boolean; onNext: () => void; loading: boolean }) {
  return (
    <div className="x-section-list x-ledger">
      <VirtualList items={entries} getKey={keyOf} label="Activity sequence" estimateSize={44} hasMore={next} loading={loading} onLoadMore={onNext}
        render={(e) => {
          const l = ledgerOf(e);
          return (
            <div className="x-ledger-row">
              <span className={`x-glyph${l.tone ? ` x-glyph-${l.tone}` : ''}`}><Icon id={l.icon} /></span>
              <div className="x-l-main"><div className="x-l-title">{l.title}</div>{l.detail ? <div className="x-l-detail">{l.detail}</div> : null}</div>
              <span className="x-l-time"><When ms={l.ts} /></span>
            </div>
          );
        }} />
    </div>
  );
}

/** XAIBO-PROD-435 (review L of -433): record loading states are announced, from a region present at every state. */
function More({ p }: { p: Paged<unknown> }) {
  return <><span className="x-sr-only" aria-live="polite">{p.failed ? 'Records could not be loaded' : p.loading ? 'Loading records' : ''}</span><MoreRow p={p} /></>;
}
function MoreRow({ p }: { p: Paged<unknown> }) {
  if (p.failed) return <p className="x-earlier">Records could not be loaded <button type="button" className="x-btn x-btn-secondary" onClick={p.loadMore}>Retry</button></p>;
  // XAIBO-PROD-433 (design §6.13 B2): a pending first page says so; no empty table stands in for "none"
  if (p.loading && !p.items.length && !p.more) return <p className="x-earlier">Loading records</p>;
  if (p.more) return <p className="x-earlier">More records available <button type="button" className="x-btn x-btn-secondary" aria-disabled={p.loading || undefined} onClick={() => { if (!p.loading) p.loadMore(); }}>{p.loading ? 'Loading next page' : 'Load more'}</button></p>;
  return p.items.length ? <p className="x-earlier">End of available records</p> : null;
}

export function Tools({ tools, touches }: { tools: Paged<ToolItem>; touches: FileItem[] }) {
  return (
    <div className="x-section-pad">
      {tools.items.length === 0 ? (tools.loading || tools.more || tools.failed ? null : <p className="x-empty-note">No tool calls recorded.</p>) : (
        <table className="x-table" aria-label="Tool ledger">
          <thead><tr><th scope="col">Tool</th><th scope="col">Approval</th><th scope="col">Started</th><th scope="col">Duration</th><th scope="col">Result</th><th scope="col">Seen by</th></tr></thead>
          <tbody>
            {tools.items.map((t) => {
              const arg = argFor(t.callId, touches);
              return (
                <tr key={t.call}>
                  <td><strong>{t.tool ? visible(t.tool) : 'Unknown tool'}</strong>{arg ? <div className="x-mono">{visible(arg)}</div> : null}</td>
                  <td><span className="x-status-cell"><Dot tone={toolTone(t)} />{approvalText(t.approval)}</span></td>
                  <td>{clock(t.ts)}</td><td>{durationLabel(t.durationMs)}</td><td>{resultText(t)}</td><td>{t.sources.map(visible).join(', ') || 'Unknown'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <More p={tools} />
    </div>
  );
}

export function Subagents({ subagents }: { subagents: Paged<SubagentItem> }) {
  return (
    <div className="x-section-pad">
      {subagents.items.length === 0 ? (subagents.loading || subagents.more || subagents.failed ? null : <p className="x-empty-note">No subagents recorded.</p>) : (
        <table className="x-table" aria-label="Subagent records">
          <thead><tr><th scope="col">Subagent</th><th scope="col">Lifecycle</th><th scope="col">Model</th><th scope="col">Started</th><th scope="col">Last record</th><th scope="col">Records</th></tr></thead>
          <tbody>
            {subagents.items.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.agentType ? visible(s.agentType) : 'Subagent'}</strong><div className="x-mono">{visible(s.nativeId)}</div></td>
                <td>{lifecycleText(s.lifecycle)}</td><td>{visible(s.model)}</td><td>{clock(s.start)}</td><td>{clock(s.end)}</td><td>{s.records.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <More p={subagents} />
    </div>
  );
}

export function Files({ files, tools }: { files: Paged<FileItem>; tools: ToolItem[] }) {
  const name = (callId: string | null) => (callId === null ? 'Unknown call' : (tools.find((t) => t.callId === callId)?.tool ?? 'Tool call'));
  return (
    <div className="x-section-pad">
      {files.items.length === 0 ? (files.loading || files.more || files.failed ? null : <p className="x-empty-note">No file touches recorded.</p>) : (
        <table className="x-table" aria-label="Files touched">
          <thead><tr><th scope="col">File</th><th scope="col">Touches</th><th scope="col">Evidence</th></tr></thead>
          <tbody>
            {groupFiles(files.items).map((g) => (
              <tr key={g.path}>
                <td><span className="x-status-cell"><Icon id="file" /><span className="x-mono">{visible(g.path)}</span></span></td>
                <td><span className="x-kinds">{g.kinds.map((k) => <span key={k} className={`x-kind${k === 'write_confirmed' ? ' x-kind-ok' : ''}`}>{k === 'write_confirmed' ? <Icon id="check" /> : null}{FILE_KIND_TEXT[k]}</span>)}</span></td>
                <td>{[...new Set(g.touches.map((t) => visible(name(t.callId))))].join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <More p={files} />
    </div>
  );
}

export type { ModelMarker };
