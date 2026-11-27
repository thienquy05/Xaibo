// XAIBO-PROD-575 (P6-T10 unit 2b; FR-06, D-PD-02; design §6.5, .handoff/p6-t10-design.md section 3, review R10): the Agent
// Map Agents mode model. One row per agent and profile from the service's integrationPage; paging reuses the tree's
// helpers (10 rows a page, three resident pages, Load previous refetches a dropped page from its own forward cursor); state
// words and glyphs follow the design's §6.5.2 table; receipts and content coverage are evidence only, never guessed.
// Rendering lives in AgentsList.tsx.
import { GAP_REASONS, type IntegrationFact, type IntegrationKey, type IntegrationPageResult, type IntegrationRow, type IntegrationState, type INTEGRATION_REFUSALS } from '../../shared/ipc.ts';
import { capText, formatTime, GAP } from '../model.ts';
import { visible } from '../text.ts';
import type { IconId } from '../status/icons.ts';
import { cursorFor, loadedText, pageArrived, pageFailed, type Dir, type Level } from './tree.ts';

export const AGENTS_PAGE = 10;
export type Mode = 'repositories' | 'agents';
export const MODES: readonly { mode: Mode; label: string }[] = [{ mode: 'repositories', label: 'Repositories' }, { mode: 'agents', label: 'Agents' }];
export type AgentLevel = Level<IntegrationRow, IntegrationKey>;

/** One stable key per agent/profile (agent ids hold no '|'). */
export const agentKey = (k: IntegrationKey) => `a:${k.agent}|${k.profileId ?? ''}`;

/** Forward cursors only: Load previous asks again from the dropped page's own cursor, as the tree does. */
export const pageRequest = (l: AgentLevel, dir: Dir) => ({ cursor: cursorFor(l, dir), direction: 'next' as const, limit: AGENTS_PAGE });

/** Gate 6 G6D1-1: a refresh refetches the resident window in sequence from its first page's cursor, each later page from the
 *  fresh page's next (never an old cursor), as many pages as were resident; a row inserted before a boundary moves to a
 *  later page instead of hiding one. null: a refusal (the caller starts over from the first page). */
export async function refreshWindow(l: AgentLevel, fetch: (cursor: IntegrationKey | null, limit: number) => Promise<IntegrationPageResult>): Promise<{ level: AgentLevel; observedAt: number } | null> {
  if (!l.pages.length) return null;
  const pages: AgentLevel['pages'] = [];
  let cursor = l.pages[0]!.from, next: IntegrationKey | null = null, observedAt = 0;
  for (let i = 0; i < l.pages.length; i++) {
    const r = await fetch(cursor, AGENTS_PAGE);
    if (r.status !== 'ready') return null;
    pages.push({ items: r.value.rows, from: cursor });
    next = r.value.next;
    observedAt = Math.max(observedAt, r.observedAt);
    if (next === null) break;
    cursor = next;
  }
  return { level: { ...l, pages, next }, observedAt };
}


export const REFUSAL_TEXT: Record<Refusal, string> = {
  starting: 'Agents are still being detected', unavailable: 'Agent evidence is unavailable', 'stale-cursor': 'The agent list changed; reloading',
  'too-large': 'Too many agent profiles to list', failed: "Couldn't load agents",
};

type Refusal = (typeof INTEGRATION_REFUSALS)[number];
/** A reply for a request of `dir` from `cursor`: a page is kept (bounded), a stale cursor asks for the first page again, any
 *  other refusal (and a stale cursor where there was none: security review L2) fails the request, keeps what is shown and
 *  names its code. */
export function pageReply(l: AgentLevel, dir: Dir, cursor: IntegrationKey | null, r: IntegrationPageResult): { level: AgentLevel; observedAt: number | null; reload: boolean; note: string; refused: Refusal | null } {
  if (r.status === 'ready') return { level: pageArrived(l, dir, cursor, r.value.rows, r.value.next), observedAt: r.observedAt, reload: false, note: loadedText(dir, 'agents', r.value.rows.length), refused: null };
  if (r.code === 'stale-cursor' && cursor !== null) return { level: { ...l, loading: null }, observedAt: null, reload: true, note: REFUSAL_TEXT['stale-cursor'], refused: null };
  return { level: pageFailed(l, dir), observedAt: null, reload: false, note: REFUSAL_TEXT[r.code], refused: r.code };
}

/** The resident rows in order; a refetched page overlapping a resident one never shows a row twice. */
export function agentItems(l: AgentLevel): IntegrationRow[] {
  const seen = new Set<string>();
  return l.pages.flatMap((p) => p.items).filter((r) => { const k = agentKey(r.key); return seen.has(k) ? false : (seen.add(k), true); });
}

/** Design §6.5.2's state table: glyph and foreground per FR-06 state. */
export const STATE: Record<IntegrationState, { text: string; icon: IconId; tone: 'ok' | 'warn' | 'muted' }> = {
  detected: { text: 'Detected', icon: 'file', tone: 'muted' },
  'setup-required': { text: 'Setup required', icon: 'settings', tone: 'warn' },
  'awaiting-trust': { text: 'Awaiting trust', icon: 'permission', tone: 'warn' },
  connected: { text: 'Connected', icon: 'link', tone: 'ok' },
  'partial-coverage': { text: 'Partial coverage', icon: 'finding', tone: 'warn' },
  'unsupported-version': { text: 'Unsupported version', icon: 'unknown', tone: 'warn' },
  'not-detected': { text: 'Not detected', icon: 'unknown', tone: 'muted' },
};
/** Design §6.5.1: after a service loss rows stay, with no unqualified claim. */
export const stateText = (r: IntegrationRow, lastKnown: boolean) => (lastKnown ? `Last known: ${STATE[r.state].text}` : STATE[r.state].text);

export const FACT: Record<IntegrationFact, string> = {
  'no-executable': 'No executable found', 'probe-not-granted': 'Detection not granted', 'probe-grant-stale': 'Detection grant out of date',
  'version-unknown': 'Version unknown', 'version-unqualified': 'Version not qualified', 'no-profile': 'No profile found', 'not-connected': 'Not connected',
  'evidence-unavailable': 'Setup evidence unavailable', drifted: 'Configuration changed outside Xaibo', 'disconnected-externally': 'Removed outside Xaibo',
  'pending-recovery': 'An earlier change needs recovery', unreadable: 'Configuration unreadable', 'hooks-blocked': 'Hooks blocked by policy (files only)',
  'no-receipt': 'Hooks installed, awaiting trust', 'waiting-for-receipt': 'Waiting for lifecycle receipt', 'hook-gap': 'Recent hook events lost',
  'content-unavailable': 'Content coverage unavailable',
};
export function reasonsText(r: IntegrationRow): string | null {
  const gaps = r.lifecycleGaps.filter((g) => (GAP_REASONS as readonly string[]).includes(g)).map((g) => GAP[g]);
  const words = r.reasons.map((f) => (f === 'hook-gap' && gaps.length ? `${FACT[f]} (${gaps.join(', ')})` : FACT[f]));
  return words.length ? words.join('; ') : null;
}

export function receiptText(r: IntegrationRow): string {
  return r.receipt ? `Lifecycle receipt: ${r.receipt.event} ${r.receipt.source}, ${formatTime(r.receipt.receivedAt)}` : 'Lifecycle receipt: none observed';
}
const MODE_TEXT: Record<IntegrationRow['content']['mode'], string> = { 'native-transcript': 'native transcript', 'report-full': 'report, full', 'report-state-only': 'report, state only', unavailable: 'unavailable' };
export function contentText(c: IntegrationRow['content']): string {
  if (c.mode === 'unavailable') return 'Content coverage: unavailable';
  return `Content coverage: ${MODE_TEXT[c.mode]}, ${c.assurance}${c.evidence ? ` (${c.evidence})` : ''}${c.gaps.length ? `; gaps: ${c.gaps.join(', ')}` : ''}`;
}

/** A row's accessible name: short and stable, never its whole content; a long profile path keeps its end, where profiles
 *  differ. */
const tail = (s: string, n: number) => ([...s].length > n ? `…${[...s].slice(-(n - 1)).join('')}` : s);
/** XAIBO-PROD-578: agent and profile, as Open integration is named. */
export const profileName = (r: IntegrationRow) => `${capText(r.name, 60)} · ${r.profileLabel === null ? 'No profile' : visible(tail(r.profileLabel, 80))}`;
export const agentLabel = (r: IntegrationRow) => `${profileName(r)} · ${STATE[r.state].text}`;
