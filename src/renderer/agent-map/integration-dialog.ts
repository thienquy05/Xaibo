// XAIBO-PROD-579 (P6-T10 unit 5; design §6.5.2, §5.1 dialog transactions, §5.4; .handoff/p6-t10-design.md section 3 "Dialog
// phases", review R1/R5/R8): the integration diff dialog model over the existing Connect (connectPreview/connectApply) and
// unit 3's previewed removal and cleanup. closed → loading → review ↔ recalculating → applying → success | failed |
// unavailable. Every write is previewed first and applied by its preview id after an explicit Apply; Connect never asks for
// the tee (unit 6); retention starts selected, a change replans and Apply waits for the replacement; needs-preview shows the
// fresh preview and waits for another Apply; a reply to an older request is dropped (seq). Rendering: IntegrationDiffDialog.tsx.
// Decision (R8): diffs show Xaibo's own values and a replaced value's type and hash; no unchanged lines (the service never
// sends whole config documents); removal and cleanup show each entry's outcome (their previews carry no lines).
import type { CleanupReply, ConnectOutcome, ConnectPreview, ConnectReply, IntegrationDetail, RemovalItem, RemovalPreview, RemovalReply } from '../../shared/ipc.ts';
import { APPLYING, RESULT_UNAVAILABLE } from '../model.ts';
import { ROUTE } from './integration-panel.ts';

export type DialogAction = { kind: 'connect'; profileId: string } | { kind: 'disconnect'; profileId: string } | { kind: 'uninstall' } | { kind: 'cleanup'; profileId: string };
export type ActionKind = DialogAction['kind'];
type CleanupPreview = Extract<CleanupReply, { status: 'preview' }>;
export type Preview = ConnectPreview | RemovalPreview | CleanupPreview;
export type Reply = ConnectReply | RemovalReply | CleanupReply;
export type Phase = 'loading' | 'review' | 'recalculating' | 'applying' | 'success' | 'failed' | 'unavailable';
/** seq: the latest request; only its reply counts. retention: what the shown (or awaited) Connect preview selected. */
export interface DialogState { action: DialogAction; phase: Phase; seq: number; preview: Preview | null; retention: boolean; expired: boolean; text: string }
export type Send = { seq: number; kind: 'preview'; retention: boolean } | { seq: number; kind: 'apply'; previewId: string };
export type DialogEvent = { type: 'reply'; seq: number; reply: Reply } | { type: 'lost'; seq: number } | { type: 'retention'; on: boolean } | { type: 'apply' } | { type: 'expired'; previewId: string };

/** seq: above every request an earlier open of the same dialog sent (code review H1: a late reply from a cancelled open is dropped). */
export function openDialog(action: DialogAction, seq = 1): { s: DialogState; send: Send } {
  const retention = action.kind === 'connect';
  return { s: { action, phase: 'loading', seq, preview: null, retention, expired: false, text: 'Preparing the preview…' }, send: { seq, kind: 'preview', retention } };
}

const itemCount = (p: Preview) => ('steps' in p ? p.steps.length : p.items.length);
export const canApply = (s: DialogState) => s.phase === 'review' && !s.expired && s.preview !== null && itemCount(s.preview) > 0;

const CHANGED = 'The configuration changed since the preview. Review the new changes, then apply again.';
export function dialogStep(s: DialogState, e: DialogEvent): { s: DialogState; send?: Send } {
  switch (e.type) {
    case 'retention': {
      const p = s.preview;
      if (s.phase !== 'review' || s.action.kind !== 'connect' || !p || !('retention' in p) || !p.retention?.offered || e.on === s.retention) return { s };
      const seq = s.seq + 1;
      return { s: { ...s, phase: 'recalculating', seq, retention: e.on, text: 'Updating the preview…' }, send: { seq, kind: 'preview', retention: e.on } };
    }
    case 'apply': {
      if (!canApply(s)) return { s };
      const seq = s.seq + 1;
      return { s: { ...s, phase: 'applying', seq, text: APPLYING }, send: { seq, kind: 'apply', previewId: s.preview!.previewId } };
    }
    case 'expired':
      return s.phase === 'review' && s.preview?.previewId === e.previewId ? { s: { ...s, expired: true, text: 'This preview expired. Close and open it again.' } } : { s };
    case 'lost':
      if (e.seq !== s.seq) return { s };
      if (s.phase === 'applying') return { s: { ...s, phase: 'unavailable', text: RESULT_UNAVAILABLE } }; // never success, rollback or cancel
      if (s.phase === 'loading' || s.phase === 'recalculating') return { s: { ...s, phase: 'failed', text: "Couldn't prepare the preview. Nothing was changed." } };
      // re-review M: the service went away while reviewing: no Apply into a dead connection; Cancel still closes
      return s.phase === 'review' ? { s: { ...s, expired: true, text: 'The service connection was lost. Nothing was changed. Close and open it again.' } } : { s };
    case 'reply': {
      if (e.seq !== s.seq) return { s };
      const r = e.reply;
      if (s.phase === 'loading' || s.phase === 'recalculating') {
        if (r.status === 'preview') return { s: { ...s, phase: 'review', preview: r, expired: false, text: s.phase === 'recalculating' ? 'Preview updated.' : '' } };
        return { s: { ...s, phase: 'failed', text: r.status === 'refused' ? refusalText(r.code) : "Couldn't prepare the preview. Nothing was changed." } };
      }
      if (s.phase !== 'applying') return { s };
      if (r.status === 'needs-preview') {
        const p = 'preview' in r ? r.preview : null;
        if (p && p.status === 'preview') return { s: { ...s, phase: 'review', preview: p, expired: false, text: CHANGED } };
        return { s: { ...s, phase: 'failed', text: p ? refusalText(p.code) : 'The configuration changed since the preview. Close and open it again.' } };
      }
      const ok = outcomeText(s.action.kind, r);
      return { s: { ...s, phase: ok.done ? 'success' : 'failed', text: ok.text } };
    }
  }
}

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const removed = (kind: ActionKind, o: ConnectOutcome) => ({ done: true, text: `${kind === 'uninstall' ? 'Uninstalled from all profiles' : 'Disconnected'}: ${n(o.reverted.filter((x) => x.result !== 'unchanged').length, 'entry', 'entries')} removed or restored${o.conflicts.length ? `; ${n(o.conflicts.length, 'changed value')} kept` : ''}.` });
function outcomeText(kind: ActionKind, r: Reply): { done: boolean; text: string } {
  switch (r.status) {
    case 'applied': return { done: true, text: `Changes applied.${r.trustSteps.length ? ' Hooks installed, awaiting trust.' : ''}` };
    case 'disconnected': return removed(kind, r as ConnectOutcome);
    case 'cleaned': return { done: true, text: `Cleaned up ${n(r.removed.length, 'leftover')}${r.left.length ? `; ${r.left.length} left` : ''}.` };
    case 'partial':
      if ('remaining' in r) {
        // revertAll marks kept conflicts partial: nothing remaining and no code means every entry was reverted, conflicts kept
        if (!r.remaining.length && r.code === undefined) return removed(kind, r);
        return { done: false, text: `Some changes were not completed (${r.code ?? 'partial'}): ${n(r.remaining.length, 'entry', 'entries')} remain${r.conflicts.length ? `, ${n(r.conflicts.length, 'changed value')} kept` : ''}. Check the panel before trying again.` };
      }
      return { done: false, text: `Cleanup stopped (${r.code}): ${r.removed.length} removed, ${r.left.length} left. Check the panel before trying again.` };
    case 'refused': return { done: false, text: refusalText(r.code) };
    default: return { done: false, text: 'An unexpected reply arrived. Check the panel before trying again.' };
  }
}

const REFUSALS: Record<string, string> = {
  'real-profile': "This profile isn't one of Xaibo's disposable test profiles; real-profile changes stay off until Gate 6.",
  busy: 'Another integration change is in progress. Close and try again shortly.', 'stale-lock': 'An earlier change stopped without finishing; restart Xaibo, then try again.',
  'preview-expired': 'This preview expired. Close and open it again.', 'preview-invalid': 'This preview is no longer valid. Close and open it again.',
  unverified: "This agent's version isn't verified for Connect.", 'helpers-unavailable': "Xaibo's hook helpers are missing; reinstall Xaibo.",
  'bounds-unavailable': "Xaibo couldn't confirm which folders are safe to change.", duplicate: 'Xaibo hooks are already present in this configuration.',
  'invalid-json': "The configuration file isn't valid JSON. Nothing was changed.", 'not-connected': 'Nothing from Xaibo is installed here.',
  'nothing-to-clean': 'There is nothing to clean up.', 'profile-not-found': 'This profile is no longer listed.', 'read-only': 'Xaibo is read-only right now. Nothing was changed.',
  starting: 'Agents are still being detected. Try again shortly.', unavailable: 'Integration changes are unavailable.', 'too-large': 'This change is too large to preview.',
  manifest: "Xaibo's integration record couldn't be read.", failed: "Couldn't complete the request.",
};
/** Codes are validated slugs (the shared parser); one Xaibo has no words for is named as it is. */
export const refusalText = (code: string) => REFUSALS[code] ?? `Couldn't continue (${code}).`;

export const actionTitle = (a: DialogAction, agent: string) =>
  a.kind === 'uninstall' ? 'Full Uninstall: all profiles' : `${a.kind === 'connect' ? 'Connect' : a.kind === 'disconnect' ? 'Disconnect' : 'Clean up'} ${agent}`;
export const applyLabel = (a: DialogAction) => ({ connect: 'Apply selected changes', disconnect: 'Disconnect', uninstall: 'Uninstall from all profiles', cleanup: 'Clean up' })[a.kind];

export interface Line { kind: 'add' | 'remove' | 'note'; text: string }
/** check: required (one selected group), on/off (deselectable), null (not selectable). */
export interface Item { id: string; title: string; check: 'required' | 'on' | 'off' | null; lines: Line[] }
const json = (v: unknown) => JSON.stringify(v) ?? 'null';
const diffLines = (st: ConnectPreview['steps'][number]): Line[] => [
  { kind: 'note', text: `File: ${st.target}` },
  ...(st.cli ? [{ kind: 'note' as const, text: `Runs: claude ${st.cli.argv.map((a) => a.join(' ')).join('; claude ')}` }, { kind: 'note' as const, text: `Writes: ${st.cli.writes.join(', ')}` }] : []),
  ...st.diff.flatMap((d): Line[] => [
    ...(d.replaced ? [{ kind: 'remove' as const, text: `${d.pointer}: existing ${d.replaced.type} value (sha256 ${d.replaced.sha256})` }] : []),
    { kind: 'add', text: `${d.pointer}: ${json(d.new)}` },
  ]),
];
const OFFER: Record<string, string> = { policy: 'set by managed policy', enough: 'already long enough', unknown: 'current value unknown', connected: 'already raised by Xaibo', unverified: 'not verified for this agent' };
const OUTCOME: Record<RemovalItem['state'], string> = {
  connected: "Xaibo's values are removed and earlier values restored", 'disconnected-externally': "already removed outside Xaibo; Xaibo's record is cleared",
  drifted: "changed outside Xaibo: unchanged Xaibo values are removed, changed values are kept", 'pending-recovery': 'an earlier change needs recovery first; left as it is',
  unreadable: "can't be read; left in place",
};
const LEFTOVER: Record<CleanupPreview['items'][number]['cleanup'][number], string> = {
  'manifest-entry': "Xaibo's record of this entry", backup: "Xaibo's private backup copy", 'plugin-copy': "Xaibo's plugin copy", marketplace: "Xaibo's plugin marketplace entry",
};

/** The profile's label from this agent's profiles; another agent's profile (Full Uninstall) is named as such. */
const profileText = (d: IntegrationDetail, id: string | null) => d.profiles.find((p) => p.id === id)?.label ?? 'another profile';
export function previewItems(s: DialogState, d: IntegrationDetail): Item[] {
  const p = s.preview;
  if (!p) return [];
  if ('steps' in p) {
    const hooks = p.steps.filter((st) => st.route !== 'claude-retention'), keep = p.steps.filter((st) => st.route === 'claude-retention');
    const out: Item[] = hooks.length ? [{ id: 'hooks', title: 'Lifecycle hooks (required)', check: 'required', lines: hooks.flatMap(diffLines) }] : [];
    const o = p.retention;
    if (o?.offered) {
      out.push({ id: 'retention', title: `Raise transcript retention from ${o.from} to ${o.to} days`, check: s.retention ? 'on' : 'off',
        lines: [...keep.flatMap(diffLines), { kind: 'note', text: "The agent's own availability of old transcripts is separate and not guaranteed." }] });
    } else if (o) out.push({ id: 'retention', title: `Transcript retention: not offered (${OFFER[o.reason] ?? o.reason})`, check: null, lines: [] });
    return out;
  }
  if ('profileId' in p) return p.items.map((i) => ({ id: i.entry, title: `${ROUTE[i.route]} · ${profileText(d, i.profileId)}`, check: null, lines: [{ kind: i.state === 'connected' ? 'remove' : 'note', text: OUTCOME[i.state] + (i.reason ? ` (${i.reason})` : '') }] }));
  const pid = s.action.kind === 'cleanup' ? s.action.profileId : null;
  return p.items.map((i) => {
    const e = d.entries.find((x) => x.entry === i.entry);
    return { id: i.entry, title: `${e ? ROUTE[e.route] : 'Integration entry'} · ${profileText(d, pid)}`, check: null, lines: i.cleanup.map((c) => ({ kind: 'remove' as const, text: LEFTOVER[c] })) };
  });
}

/** Removal entries Xaibo will not simply undo: changed outside Xaibo (kept), unreadable or awaiting recovery (left). */
export function conflictTexts(s: DialogState, d: IntegrationDetail): string[] {
  const p = s.preview;
  if (!p || !('items' in p) || !('profileId' in p)) return [];
  return p.items.filter((i) => i.state === 'drifted' || i.state === 'unreadable' || i.state === 'pending-recovery')
    .map((i) => `${ROUTE[i.route]} · ${profileText(d, i.profileId)}: ${OUTCOME[i.state]}${i.reason ? ` (${i.reason})` : ''}`);
}

export function effectTexts(s: DialogState): string[] {
  const p = s.preview;
  switch (s.action.kind) {
    case 'connect': return [...(p && 'trustSteps' in p ? p.trustSteps.map((t) => `After applying: ${t}`) : []), 'Existing commands from other tools stay in place.'];
    case 'uninstall': return ['Removes every Xaibo integration listed, in every profile. Session history is kept, and Xaibo stays installed.'];
    case 'disconnect': return ['Session history is kept.'];
    case 'cleanup': return ["Only Xaibo's own leftovers are removed."];
  }
}

const CONNECTABLE = ['claude', 'codex', 'agy'];
const LIFECYCLE = ['claude-plugin', 'claude-settings-fallback', 'codex-hooks', 'agy-hooks'];
/** Which writes the panel offers. ponytail: Full Uninstall is offered from a profile with entries only (each profile's panel
 *  reaches it); add a global entry point if entries in unlisted profiles need one. */
export function panelActions(d: IntegrationDetail): ActionKind[] {
  const { agent, profileId } = d.row.key;
  if (profileId === null) return [];
  const out: ActionKind[] = [];
  if (CONNECTABLE.includes(agent) && d.row.state !== 'not-detected' && d.row.state !== 'unsupported-version' && !d.entries.some((e) => LIFECYCLE.includes(e.route))) out.push('connect');
  if (d.entries.length) out.push('disconnect', 'uninstall');
  if (d.entries.some((e) => e.state === 'disconnected-externally')) out.push('cleanup');
  return out;
}
