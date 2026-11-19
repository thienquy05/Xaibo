// P4-T01 (design §3.1–§3.2, §4): status presentation. All 21 lifecycle × confidence labels, their icons and tones;
// heuristic waits read "Probably waiting"; missing evidence is Unknown, never Idle; reasons map to their icons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusPresentation } from '../../../src/renderer/status/presentation.ts';
import { ICON_IDS, ICONS } from '../../../src/renderer/status/icons.ts';
import { LIFECYCLES } from '../../../src/shared/ipc.ts';

const CONF = ['confirmed', 'inferred', 'heuristic'] as const;
const NAME = { idle: 'Idle', busy: 'Busy', 'waiting-for-permission': 'Waiting for permission', 'needs-input': 'Needs input', error: 'Error', ended: 'Ended', unknown: 'Unknown' } as const;
const ICON = { idle: 'idle', busy: 'busy', 'waiting-for-permission': 'permission', 'needs-input': 'input', error: 'error', ended: 'ended', unknown: 'unknown' } as const;
const TONE = { idle: 'muted', busy: 'accent', 'waiting-for-permission': 'warning', 'needs-input': 'warning', error: 'danger', ended: 'muted', unknown: 'muted' } as const;
const EVIDENCE = { confirmed: 'evidence-solid', inferred: 'evidence-open', heuristic: 'evidence-dashed' } as const;

test('all 21 lifecycle × confidence pairs: exact design label, lifecycle and evidence icons, semantic tone', () => {
  let n = 0;
  for (const l of LIFECYCLES) for (const c of CONF) {
    const p = statusPresentation(l, c);
    const wait = c === 'heuristic' && (l === 'waiting-for-permission' || l === 'needs-input');
    assert.equal(p.label, wait ? 'Probably waiting · heuristic' : `${NAME[l]} · ${c}`, `${l}/${c}`);
    assert.equal(p.icon, ICON[l]);
    assert.equal(p.confidenceIcon, EVIDENCE[c]);
    assert.equal(p.tone, TONE[l]);
    assert.ok(ICON_IDS.includes(p.icon) && ICON_IDS.includes(p.confidenceIcon), 'only designed icons');
    n++;
  }
  assert.equal(n, 21);
});

test('a heuristic wait names its underlying lifecycle in the detail and never claims an observed prompt', () => {
  const p = statusPresentation('waiting-for-permission', 'heuristic', ['Probably waiting']);
  assert.equal(p.label, 'Probably waiting · heuristic');
  assert.equal(p.detail, 'Underlying state: Waiting for permission (heuristic, no observed prompt)');
  assert.deepEqual(p.reasons, [], '"Probably waiting" is the label, not a separate reason');
  assert.equal(statusPresentation('needs-input', 'heuristic').detail, 'Underlying state: Needs input (heuristic, no observed prompt)');
  assert.equal(statusPresentation('waiting-for-permission', 'confirmed').detail, null);
});

test('missing lifecycle or confidence is Unknown · heuristic with "No eligible state evidence", never Idle', () => {
  for (const [l, c] of [[null, null], [null, 'confirmed'], ['idle', null]] as const) {
    const p = statusPresentation(l, c);
    assert.equal(p.label, 'Unknown · heuristic');
    assert.equal(p.icon, 'unknown');
    assert.equal(p.confidenceIcon, 'evidence-dashed');
    assert.equal(p.detail, 'No eligible state evidence');
    assert.doesNotMatch(p.label, /Idle/);
  }
});

test('reasons: Finishing… (settle, muted) and Background work (branch, accent) after the lifecycle; unknown reasons dropped', () => {
  const p = statusPresentation('busy', 'confirmed', ['Finishing…', 'Background work', 'something else']);
  assert.equal(p.label, 'Busy · confirmed', 'a reason never changes lifecycle or confidence');
  assert.deepEqual(p.reasons, [
    { label: 'Finishing…', icon: 'settle', tone: 'muted' },
    { label: 'Background work', icon: 'branch', tone: 'accent' },
  ]);
});

test('icon geometry is exactly design §4 (review of P4-T01)', () => {
  const P = (d: string) => ({ kind: 'path', d });
  const R = (x: number, y: number, w: number, h: number, more: object = {}) => ({ kind: 'rect', x, y, w, h, ...more });
  const C = (cx: number, cy: number, r: number) => ({ kind: 'circle', cx, cy, r });
  assert.deepEqual(Object.fromEntries(Object.entries(ICONS).filter(([id]) => !['dashboard', 'session', 'link', 'hourglass', 'restore', 'finding'].includes(id))), {
    idle: [C(12, 12, 7)],
    busy: [P('M3 15 L7 9 L12 15 L17 9 L21 15')],
    permission: [P('M6 20 L6 10 L9 10 L9 5 L12 5 L12 11 L15 8 L18 11 L18 17 L15 20 L6 20')],
    input: [R(4, 5, 16, 11), P('M8 16 L8 20 L12 16'), P('M8 10 L16 10')],
    error: [P('M6 6 L18 18'), P('M18 6 L6 18'), C(12, 12, 10)],
    ended: [R(5, 5, 14, 14), P('M9 12 L15 12')],
    unknown: [P('M9 4 L4 4 L4 20 L9 20'), P('M15 4 L20 4 L20 20 L15 20'), C(12, 12, 1)],
    'evidence-solid': [R(7, 7, 10, 10, { fill: true })],
    'evidence-open': [R(7, 7, 10, 10)],
    'evidence-dashed': [R(7, 7, 10, 10, { dash: true })],
    settle: [P('M5 6 L19 6'), P('M5 12 L15 12'), P('M5 18 L11 18')],
    branch: [P('M7 3 L7 17 L11 21'), P('M7 11 L17 11 L17 5')],
    // P4-T05d: chevron, back, close, check, information, file, external rows of design §4
    chevron: [P('M9 5 L16 12 L9 19')],
    back: [P('M13 5 L6 12 L13 19'), P('M6 12 L21 12')],
    close: [P('M6 6 L18 18'), P('M18 6 L6 18')],
    check: [P('M4 12 L9 17 L20 6')],
    information: [C(12, 12, 9), P('M12 11 L12 17'), C(12, 7, 0.5)],
    file: [P('M6 3 L14 3 L19 8 L19 21 L6 21 L6 3'), P('M14 3 L14 8 L19 8')],
    external: [R(4, 9, 11, 11), P('M10 14 L20 4'), P('M13 4 L20 4 L20 11')],
    // P4-T06b: the Stale glyph of design §4
    'clock-gap': [P('M12 3 L5 3 L3 10 L5 18 L12 21 L20 17 L21 10'), P('M12 7 L12 12 L16 12')],
    // XAIBO-PROD-438 (D-P4-10): the loading glyph of design §4
    loading: [P('M12 4 A8 8 0 1 1 4 12')],
    // XAIBO-PROD-525 (P5-T16): Settings navigation
    settings: [R(4, 4, 16, 16), P('M4 9 L20 9'), P('M9 4 L9 9'), P('M4 15 L20 15'), P('M15 15 L15 20')],
    // XAIBO-PROD-529 (P5-T18 part 3a): search, pin and folder rows of design §4
    search: [C(10, 10, 6), P('M15 15 L21 21')],
    pin: [P('M7 4 L17 4 L15 11 L19 15 L5 15 L9 11 L7 4'), P('M12 15 L12 22')],
    folder: [P('M3 6 L10 6 L12 9 L21 9 L21 20 L3 20 L3 6')],
  });
});
