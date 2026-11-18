// XAIBO-PROD-412 (P4-T05c; design §6.3 Timeline/Tools/Subagents/Files): the Activity sequence and workspace labels.
// Transcript items keep the service's source order; nothing is re-sorted by the renderer's clock. Entries that have no
// transcript position (model markers, hook-only tools, subagent start/end) are placed by their service time before the
// first loaded item at or after it. A tool appears once whatever its provenance.
import type { FileItem, ModelMarker, SubagentItem, ToolItem, TranscriptItem } from '../../shared/ipc.ts';
import { durationText } from '../overview/queue.ts';

export type Entry =
  | { key: string; kind: 'prompt' | 'response' | 'tool-result' | 'compaction' | 'interrupted' | 'large'; item: TranscriptItem }
  | { key: string; kind: 'tool'; item: TranscriptItem | null; tool: ToolItem | null }
  | { key: string; kind: 'model'; marker: ModelMarker }
  | { key: string; kind: 'subagent-start' | 'subagent-end'; subagent: SubagentItem };
/** moreBefore/moreAfter: the service has transcript beyond the loaded items on that side. */
export interface TimelineInput { items: TranscriptItem[]; tools: ToolItem[]; markers: ModelMarker[]; subagents: SubagentItem[]; moreBefore: boolean; moreAfter: boolean }

type Timed = { ts: number; rank: number; id: number; entry: Entry };

export function mergeTimeline(i: TimelineInput): Entry[] {
  const byArgs = new Map<number, ToolItem>(), byResult = new Map<number, ToolItem>(), byCallId = new Map<string, ToolItem>();
  for (const t of i.tools) {
    if (t.argsEvent !== null) byArgs.set(t.argsEvent, t);
    if (t.resultEvent !== null) byResult.set(t.resultEvent, t);
    if (t.callId !== null) byCallId.set(t.callId, t);
  }
  // A call without a transcript item but with a service time is placed by that time, so it never moves when its result's
  // page loads (review M1). ponytail: a call with neither a transcript item nor a time has no evidenced position; it
  // stays in the Tools ledger only.
  const timedTool = (t: ToolItem) => t.argsEvent === null && t.ts !== null;
  const used = new Set<ToolItem>();
  const shownCalls = new Set<string>(); // call ids whose call item is already in the sequence
  const placed: Entry[] = [];
  const foldInto = new Map<Entry, string>(); // a result kept only while its timed call is not shown
  for (const it of i.items) {
    const key = `e:${it.event}`; // review L5: an item's key never changes when its tool record loads later
    if (it.kind === 'tool-call') {
      // The call-id fallback only joins a record that names no other call item and is not claimed yet (re-review).
      const c = it.callId !== null ? byCallId.get(it.callId) : undefined;
      const t = byArgs.get(it.event) ?? (c && c.argsEvent === null && !used.has(c) ? c : undefined);
      if (t) used.add(t);
      const id = t?.callId ?? it.callId;
      if (id !== null) shownCalls.add(id);
      placed.push({ key, kind: 'tool', item: it, tool: t ?? null });
    } else if (it.kind === 'tool-result') {
      const t = byResult.get(it.event) ?? (it.callId !== null ? byCallId.get(it.callId) : undefined);
      const id = t?.callId ?? it.callId;
      if ((t && used.has(t)) || (id !== null && shownCalls.has(id))) continue; // folds into its call item's entry
      if (t && t.argsEvent === null && t.ts === null) { // an untimed call without a call item: the result is its only position
        used.add(t);
        placed.push({ key, kind: 'tool', item: it, tool: t });
        continue;
      }
      const e: Entry = { key, kind: 'tool-result', item: it };
      if (t && timedTool(t)) foldInto.set(e, `c:${t.call}`);
      placed.push(e);
    } else placed.push({ key, kind: it.kind, item: it });
  }

  // Time-placed entries in a stable order: time, then marker < subagent start < tool < subagent end, then id.
  const timed: Timed[] = [];
  for (const m of i.markers) timed.push({ ts: m.ts, rank: 0, id: m.turn, entry: { key: `m:${m.turn}`, kind: 'model', marker: m } });
  for (const s of i.subagents) {
    if (s.start !== null) timed.push({ ts: s.start, rank: 1, id: s.id, entry: { key: `s:${s.id}:start`, kind: 'subagent-start', subagent: s } });
    if (s.end !== null && s.lifecycle === 'ended') timed.push({ ts: s.end, rank: 3, id: s.id, entry: { key: `s:${s.id}:end`, kind: 'subagent-end', subagent: s } });
  }
  for (const t of i.tools) if (!used.has(t) && timedTool(t)) timed.push({ ts: t.ts!, rank: 2, id: t.call, entry: { key: `c:${t.call}`, kind: 'tool', item: null, tool: t } });
  timed.sort((a, b) => a.ts - b.ts || a.rank - b.rank || a.id - b.id);

  const tsOf = (e: Entry) => ('item' in e && e.item ? e.item.ts : null);
  const first = placed.map(tsOf).find((t): t is number => t !== null);
  // An entry at or before the first loaded item's time may belong to an unloaded earlier page (an earlier item can share
  // its millisecond, review L3); one after every loaded item, to a later page. Both wait for that page, so loading it
  // never reorders what is shown. With nothing timed loaded and more before, nothing is placed (review L4).
  const early = (ts: number) => i.moreBefore && (first === undefined || ts <= first);
  const out: Entry[] = [];
  let k = 0;
  const flush = (upTo: number) => { for (; k < timed.length && timed[k]!.ts <= upTo; k++) if (!early(timed[k]!.ts)) out.push(timed[k]!.entry); };
  for (const e of placed) {
    const ts = tsOf(e);
    if (ts !== null) flush(ts);
    out.push(e);
  }
  if (!i.moreAfter) for (; k < timed.length; k++) if (!early(timed[k]!.ts)) out.push(timed[k]!.entry);
  const shown = new Set(out.map((e) => e.key));
  return out.filter((e) => !shown.has(foldInto.get(e) ?? ''));
}

export const toolTitle = (t: Pick<ToolItem, 'tool'>): string => `Tool call — ${t.tool ?? 'Unknown tool'}`;
const APPROVAL_TEXT: Record<NonNullable<ToolItem['approval']>, string> = {
  not_requested: 'No approval requested', requested: 'Approval requested', approved: 'Approved', denied: 'Denied',
};
export const approvalText = (a: ToolItem['approval']): string => (a ? APPROVAL_TEXT[a] : 'Approval unknown');
export const durationLabel = (ms: number | null): string => (ms === null ? 'Duration unavailable' : durationText(ms));
/** Never success without evidence: only a reported `is_error: false` reads Completed. */
export function resultText(t: Pick<ToolItem, 'error' | 'resultEvent'>): string {
  if (t.error !== null) return t.error ? 'Error' : 'Completed';
  return t.resultEvent !== null ? 'Result recorded' : 'Result unavailable';
}
export const lifecycleText = (l: SubagentItem['lifecycle']): string => (l === 'running' ? 'Running' : l === 'ended' ? 'Ended' : 'Unknown');
export const FILE_KIND_TEXT: Record<FileItem['kind'], string> = { read: 'Read', write_attempted: 'Write attempted', write_confirmed: 'Write confirmed' };

export interface FileGroup { path: string; kinds: FileItem['kind'][]; touches: FileItem[] }
const KIND_ORDER = Object.keys(FILE_KIND_TEXT) as FileItem['kind'][];
/** Loaded file records grouped by path in first-seen order; each kind once, in the fixed label order. */
export function groupFiles(touches: FileItem[]): FileGroup[] {
  const groups = new Map<string, FileItem[]>();
  for (const t of touches) {
    const g = groups.get(t.path);
    if (g) g.push(t);
    else groups.set(t.path, [t]);
  }
  return [...groups].map(([path, ts]) => ({ path, kinds: KIND_ORDER.filter((k) => ts.some((t) => t.kind === k)), touches: ts }));
}
