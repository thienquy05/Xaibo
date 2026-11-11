// XAIBO-PROD-110 (P1-T12, EC-55, SEC3): transcript strings shown as text; ANSI, control and bidi characters become
// visible escapes so they can neither style nor reorder what is displayed. HTML stays literal text (React text nodes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visible } from '../../src/renderer/text.ts';

test('ANSI sequences and C0 controls become visible escapes', () => {
  assert.equal(visible('\u001b[31mred\u001b[0m'), '\\x1B[31mred\\x1B[0m');
  assert.equal(visible('a\nb\tc\rd\0e\u0007'), 'a\\x0Ab\\x09c\\x0Dd\\x00e\\x07');
});

test('DEL and C1 controls become visible escapes', () => {
  assert.equal(visible('x\u007fy\u0085z\u009b'), 'x\\x7Fy\\x85z\\x9B');
});

test('bidi overrides and isolates become visible escapes', () => {
  assert.equal(visible('abc‮def⁦g⁩'), 'abc\\u202Edef\\u2066g\\u2069');
});

test('ordinary text, Unicode, HTML and markdown are left as they are', () => {
  for (const s of ['plain', '/tmp/xaibo-fixture/café \u{1F600} 日本', '<img src=x onerror=alert(1)>', '**bold** [l](u)', '']) assert.equal(visible(s), s);
});

test('H3: LRM, RLM and ALM marks become visible escapes', () => {
  assert.equal(visible('a‎b‏c؜d'), 'a\\u200Eb\\u200Fc\\u061Cd');
});
