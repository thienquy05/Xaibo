// P4-T03 (design §5.1 virtualized record list, §5.2): the pure model behind VirtualList. Roving focus moves within the
// loaded range; reaching the loaded end by arrow fetches once per edge; rows inserted above the anchor shift the scroll
// offset by exactly their measured heights, so the record in view stays put.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorShift, createEdgeFetch, focusIndex, nextFocus, pageAnnouncement, pickAnchor } from '../../../src/renderer/components/virtual-list-model.ts';

test('Arrow/Home/End move within the loaded range and stop at its bounds; other keys are not navigation', () => {
  assert.equal(nextFocus(3, 'ArrowDown', 10), 4);
  assert.equal(nextFocus(3, 'ArrowUp', 10), 2);
  assert.equal(nextFocus(9, 'ArrowDown', 10), 9, 'bottom bound');
  assert.equal(nextFocus(0, 'ArrowUp', 10), 0, 'top bound');
  assert.equal(nextFocus(5, 'Home', 10), 0);
  assert.equal(nextFocus(5, 'End', 10), 9, 'End is the loaded range, not the archive');
  assert.equal(nextFocus(-1, 'ArrowDown', 10), 0, 'no focus yet starts at the first record');
  assert.equal(nextFocus(0, 'ArrowDown', 0), -1, 'empty list');
  for (const k of ['Enter', 'Tab', 'a', 'PageDown']) assert.equal(nextFocus(3, k, 10), null, k);
});

test('the edge fetch fires once per edge: ArrowDown on the last loaded record with more available', () => {
  const edge = createEdgeFetch();
  assert.equal(edge('ArrowDown', 8, 10, true), false, 'not at the edge');
  assert.equal(edge('End', 9, 10, true), false, 'End only jumps; Load more stays explicit');
  assert.equal(edge('ArrowDown', 9, 10, false), false, 'nothing more to load');
  assert.equal(edge('ArrowDown', 9, 10, true), true, 'fires at the edge');
  assert.equal(edge('ArrowDown', 9, 10, true), false, 'only once for this edge');
  assert.equal(edge('ArrowDown', 19, 20, true), true, 'the next page brings a new edge');
});

test('rows inserted above the anchor shift it by their measured heights; rows below or a lost anchor shift nothing', () => {
  const size = (k: string) => (k.startsWith('new') ? 40 + Number(k.slice(3)) : 100);
  assert.equal(anchorShift(['a', 'b', 'c'], ['new1', 'new2', 'a', 'b', 'c'], 'b', size), 41 + 42);
  assert.equal(anchorShift(['a', 'b', 'c'], ['a', 'b', 'new1', 'c'], 'b', size), 0);
  assert.equal(anchorShift(['a', 'b', 'c'], ['b', 'c'], 'b', size), -100, 'a row removed above the anchor');
  assert.equal(anchorShift(['a', 'b'], ['new1', 'a'], 'b', size), 0, 'anchor gone: no shift');
});

test('review M1/L1: focus follows its record by key across reorders; a removed record hands focus to its neighbour', () => {
  assert.equal(focusIndex(['a', 'b', 'c'], 'b', 1), 1);
  assert.equal(focusIndex(['b', 'a', 'c'], 'b', 1), 0, 'b moved to the head: focus moves with it');
  assert.equal(focusIndex(['a', 'c'], 'b', 1), 1, 'b removed: the nearest following record');
  assert.equal(focusIndex(['a'], 'b', 2), 0, 'nothing follows: the previous record');
  assert.equal(focusIndex([], 'b', 0), -1);
  assert.equal(focusIndex(['a', 'b'], null, -1), -1, 'no focus yet');
});

test('review M2: the anchor is a record in view that kept its place relative to the others, not one that jumped', () => {
  // in view: c d e; d gets activity and jumps to the head; two new rows also arrive at the head
  const prev = ['a', 'b', 'c', 'd', 'e', 'f'];
  const next = ['n1', 'n2', 'd', 'a', 'b', 'c', 'e', 'f'];
  assert.equal(pickAnchor(prev, next, ['c', 'd', 'e']), 'c');
  assert.equal(pickAnchor(prev, ['d', 'a', 'b', 'c', 'e', 'f'], ['d', 'e']), 'e', 'the first in view moved: the next stable one');
  assert.equal(pickAnchor(prev, ['x'], ['c', 'd']), null, 'none left');
  const size = () => 100;
  assert.equal(anchorShift(prev, next, pickAnchor(prev, next, ['c', 'd', 'e'])!, size), 300, 'c: two new rows plus d above it now');
});

test('review M4: pagination announcements (polite), never an invented total', () => {
  assert.equal(pageAnnouncement(50, 50, true), 'Loading next page');
  assert.equal(pageAnnouncement(50, 100, false), '50 more records loaded');
  assert.equal(pageAnnouncement(50, 51, false), '1 more record loaded');
  assert.equal(pageAnnouncement(50, 50, false), '');
});

// XAIBO-PROD-407 (P4-T04c, design §6.1): the Dashboard view group roves with Left/Right/Home/End; vertical arrows do not.
test('horizontal roving: Left/Right/Home/End within bounds; Up/Down are not navigation there', () => {
  assert.equal(nextFocus(0, 'ArrowRight', 3, 'horizontal'), 1);
  assert.equal(nextFocus(2, 'ArrowRight', 3, 'horizontal'), 2, 'right bound');
  assert.equal(nextFocus(1, 'ArrowLeft', 3, 'horizontal'), 0);
  assert.equal(nextFocus(1, 'End', 3, 'horizontal'), 2);
  assert.equal(nextFocus(2, 'Home', 3, 'horizontal'), 0);
  assert.equal(nextFocus(1, 'ArrowDown', 3, 'horizontal'), null);
  assert.equal(nextFocus(1, 'ArrowRight', 3), null, 'vertical lists ignore Left/Right');
});

// XAIBO-PROD-439 (P4-T15b; design §2.3, §2.4): after rows re-measure, a focused record is scrolled back into view with
// room for its focus ring; one already in view is left alone.
test('revealDelta: 0 in view; else the scroll that brings the item inside the port with padding', async () => {
  const { revealDelta } = await import('../../../src/renderer/components/virtual-list-model.ts');
  const port = { top: 100, bottom: 500 };
  assert.equal(revealDelta({ top: 200, bottom: 260 }, port), 0);
  assert.equal(revealDelta({ top: 520, bottom: 580 }, port), 88, 'below: bottom + 8 px padding reaches the port bottom');
  assert.equal(revealDelta({ top: 40, bottom: 100 }, port), -68, 'above: top - 8 px padding reaches the port top');
  assert.equal(revealDelta({ top: 50, bottom: 600 }, port), -58, 'taller than the port: its top is shown');
  assert.equal(revealDelta({ top: 96, bottom: 150 }, port, 0), -4, 'padding is configurable');
});

// XAIBO-PROD-439 review HIGH: only a layout change of the list (its width or text metrics: text spacing, text size, zoom)
// brings the focused record back; measuring rows while the user scrolls, or a change of records, never moves the scroll.
test('shouldReveal: a layout change with the same records and a focused record', async () => {
  const { layoutSignature, shouldReveal } = await import('../../../src/renderer/components/virtual-list-model.ts');
  assert.equal(shouldReveal(5, true, false), true);
  assert.equal(shouldReveal(5, false, false), false, 'rows measured while scrolling: leave the scroll alone');
  assert.equal(shouldReveal(5, true, true), false, 'records changed: never');
  assert.equal(shouldReveal(null, true, false), false, 'nothing focused');
  const sig = (o: object) => layoutSignature({ width: 300, fontSize: '14px', lineHeight: '22px', letterSpacing: 'normal', wordSpacing: '0px', ...o });
  assert.equal(sig({}), sig({}));
  for (const o of [{ width: 301 }, { fontSize: '28px' }, { lineHeight: '21px' }, { letterSpacing: '1.68px' }, { wordSpacing: '2.24px' }]) assert.notEqual(sig(o), sig({}), JSON.stringify(o));
});

// XAIBO-PROD-439: rows re-measure over several commits after one layout change; each of them keeps the focused record
// in view for a short window, then measuring while the user scrolls is left alone again.
test('revealDue: a layout change opens a 500 ms window; later re-measures inside it are due', async () => {
  const { revealDue } = await import('../../../src/renderer/components/virtual-list-model.ts');
  assert.deepEqual(revealDue('', 'a', 1000, 0), { due: false, until: 0 }, 'first measurement: nothing changed');
  assert.deepEqual(revealDue('a', 'b', 1000, 0), { due: true, until: 1500 });
  assert.deepEqual(revealDue('b', 'b', 1400, 1500), { due: true, until: 1500 }, 'a later commit in the window');
  assert.deepEqual(revealDue('b', 'b', 1600, 1500), { due: false, until: 1500 }, 'after the window');
});

// XAIBO-PROD-439: the part of a list's scroller a focused record must sit in: the scroller clipped to the window and
// below the sticky top frame's padding (arrow-key focus scrolled only the inner scroller, leaving the record below the
// window when the page around the list scrolls).
test('revealPort: scroller ∩ window, below the top padding', async () => {
  const { revealPort } = await import('../../../src/renderer/components/virtual-list-model.ts');
  assert.deepEqual(revealPort({ top: 595, bottom: 1133 }, 768, 64), { top: 595, bottom: 768 });
  assert.deepEqual(revealPort({ top: -100, bottom: 400 }, 768, 64), { top: 64, bottom: 400 });
  assert.deepEqual(revealPort({ top: 10, bottom: 900 }, 768, 8), { top: 10, bottom: 768 });
});

// XAIBO-PROD-439: arrow-key focus moves the page only when the window (or the sticky frame) clips the list's scroller;
// a scroller that fits the window is left to the virtualizer (scrolling the record there fought scrollToIndex).
test('scrollerClipped: the scroller extends past the window bottom or above the top padding', async () => {
  const { scrollerClipped } = await import('../../../src/renderer/components/virtual-list-model.ts');
  assert.equal(scrollerClipped({ top: 595, bottom: 1133 }, 768, 64), true, 'below the fold (Dashboard)');
  assert.equal(scrollerClipped({ top: 30, bottom: 500 }, 768, 64), true, 'under the sticky frame');
  assert.equal(scrollerClipped({ top: 120, bottom: 620 }, 768, 64), false, 'fits (Session area)');
});

// XAIBO-PROD-530 (D-P5-11): a keyboard-focused record whose top sits above the reveal port (under the sticky top band or
// its scroller's top) is shown from its start; one whose top is in view, or below the port, is left to the browser.
test('startHidden: the focused element starts above the reveal port top', async () => {
  const { startHidden } = await import('../../../src/renderer/components/virtual-list-model.ts');
  assert.equal(startHidden({ top: 87 }, { top: 139 }, true), true, 'a 200 % text record under the band (D-P5-11)');
  assert.equal(startHidden({ top: 139 }, { top: 139 }, true), false, 'at the port top');
  assert.equal(startHidden({ top: 138.5 }, { top: 139 }, true), false, 'sub-pixel rounding');
  assert.equal(startHidden({ top: 400 }, { top: 139 }, true), false, 'in view');
  assert.equal(startHidden({ top: 900 }, { top: 139 }, true), false, 'below: the browser brings it up');
  // review M1: the window regaining focus (no element focus moved from) never undoes the user's own scrolling
  assert.equal(startHidden({ top: 87 }, { top: 139 }, false), false, 'window refocus');
});
