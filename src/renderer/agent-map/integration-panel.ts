// XAIBO-PROD-578 (P6-T10 unit 4b; design §6.5.2, .handoff/p6-t10-design.md section 3 "Test receipt", review R1/R8): the
// integration panel model. Test receipt: no new endpoint and nothing runs; the panel reads its detail every TEST_POLL_MS for
// up to TEST_TIMEOUT_MS and succeeds only on a receipt received after the test started (the service's observation time at
// the click) and after the current install boundary, so an old or replayed delivery, or one from before a reinstall, never
// counts. Texts for the reconcile entries and the status-only tee and notify lines. Rendering lives in IntegrationPanel.tsx.
// ponytail: bounded polling while the panel shows; push delivery only if measured latency warrants it.
import type { IntegrationDetail, IntegrationRow, RemovalItem } from '../../shared/ipc.ts';
import { formatTime } from '../model.ts';

export const TEST_POLL_MS = 2_000, TEST_TIMEOUT_MS = 60_000;
type Receipt = NonNullable<IntegrationRow['receipt']>;
export type ReceiptTest = { phase: 'idle' } | { phase: 'waiting'; startedAt: number; until: number } | { phase: 'received'; receipt: Receipt } | { phase: 'timeout' };

/** `observedAt`: the service's time of the detail read at the click (the test boundary). */
export const startTest = (observedAt: number): ReceiptTest => ({ phase: 'waiting', startedAt: observedAt, until: observedAt + TEST_TIMEOUT_MS });
export function pollTest(t: ReceiptTest, d: IntegrationDetail, observedAt: number): ReceiptTest {
  if (t.phase !== 'waiting') return t;
  const r = d.row.receipt;
  if (r && r.receivedAt > t.startedAt && (d.boundary === null || r.receivedAt > d.boundary)) return { phase: 'received', receipt: r };
  return observedAt >= t.until ? { phase: 'timeout' } : t;
}
/** Offered only where a lifecycle integration is installed. */
export const testable = (d: IntegrationDetail) => d.boundary !== null;
export function testText(t: ReceiptTest): string | null {
  switch (t.phase) {
    case 'waiting': return 'Waiting for test receipt…';
    case 'timeout': return 'No receipt observed. Check trust and profile, then retry.';
    case 'received': return `Receipt observed: ${t.receipt.event} ${t.receipt.source}, ${formatTime(t.receipt.receivedAt)}`;
    default: return null;
  }
}

export const ROUTE: Record<RemovalItem['route'], string> = {
  'claude-plugin': 'Claude plugin hooks', 'claude-settings-fallback': 'Claude settings hooks', 'claude-retention': 'Transcript retention',
  'claude-tee': 'Status-line tee', 'codex-hooks': 'Codex hooks', 'agy-hooks': 'Antigravity hooks',
  'report-setup': 'Report setup', // XAIBO-PROD-589; ponytail: the panel offers no report Connect yet (P6-T08/T12), only lists entries
};
const STATE: Record<RemovalItem['state'], string> = {
  connected: 'intact', 'disconnected-externally': 'removed outside Xaibo', drifted: 'changed outside Xaibo', 'pending-recovery': 'needs recovery', unreadable: 'unreadable',
};
type Entry = IntegrationDetail['entries'][number];
export const entryText = (e: Entry) => `${ROUTE[e.route]}: ${STATE[e.state]}${e.state === 'unreadable' && e.reason ? ` (${e.reason})` : ''}`;

/** Status only (review R1: no write control before its preview, units 5-6). */
export function teeText(d: IntegrationDetail): string | null {
  if (d.row.key.agent !== 'claude') return null;
  const tee = d.entries.find((e) => e.route === 'claude-tee');
  return `Optional status-line tee: ${!tee ? 'off' : tee.state === 'connected' ? 'on' : STATE[tee.state]}`;
}
/** Review R8: the Codex notify wrapper stays visibly unavailable until its own verified transaction exists. */
export const notifyText = (d: IntegrationDetail) => (d.row.key.agent === 'codex' ? 'Codex notify wrapper: unavailable (no verified setup yet)' : null);

/** Back to map: the originating row while loaded; null = the Agents heading. ponytail: no next/previous-row fallback (rows are
 *  not removed from the panel until unit 5's actions). */
export const restoreTarget = (keys: readonly string[], origin: string) => (keys.includes(origin) ? origin : null);
