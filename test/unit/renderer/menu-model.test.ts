// XAIBO-PROD-532 (P5-T18 part 3b-3; design §5.1 Menu): menu keys. Up/Down move and wrap, Home/End jump, a printable
// character moves to the next item starting with it (wrapping, case-insensitive); other keys are not the menu's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuKey } from '../../../src/renderer/components/menu-model.ts';

const labels = ['Pin', 'Archive', 'Keep', 'Move to Trash'];

test('menuKey: Up/Down wrap; Home/End', () => {
  assert.equal(menuKey('ArrowDown', 0, labels), 1);
  assert.equal(menuKey('ArrowDown', 3, labels), 0);
  assert.equal(menuKey('ArrowUp', 0, labels), 3);
  assert.equal(menuKey('ArrowUp', 2, labels), 1);
  assert.equal(menuKey('Home', 2, labels), 0);
  assert.equal(menuKey('End', 0, labels), 3);
});

test('menuKey: typeahead to the next item starting with the character, wrapping; no match or other keys: null', () => {
  assert.equal(menuKey('k', 0, labels), 2);
  assert.equal(menuKey('M', 0, labels), 3);
  assert.equal(menuKey('p', 3, labels), 0, 'wraps');
  assert.equal(menuKey('a', 1, ['Pin', 'Archive', 'Add']), 2, 'the next one after the current');
  assert.equal(menuKey('z', 0, labels), null);
  for (const key of ['Tab', 'Enter', ' ', 'ArrowLeft', 'Shift']) assert.equal(menuKey(key, 0, labels), null, key);
  assert.equal(menuKey('ArrowDown', 0, []), null, 'an empty menu');
});
