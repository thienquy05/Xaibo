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
