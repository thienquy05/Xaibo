// XAIBO-PROD-555 review re-check LOW: in a zone east of UTC, From = 1970-01-01 is a local midnight before epoch 0, which
// the service refuses (parseFilter msOk); dayRange refuses it on Apply with its message instead of a failed list.
process.env.TZ = 'Asia/Tokyo';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayRange } from '../../../src/renderer/history/browse.ts';

test('dayRange east of UTC: a local midnight before epoch 0 is invalid; the next day is fine', () => {
  assert.equal(dayRange('1970-01-01', '1970-01-02'), undefined);
  assert.deepEqual(dayRange('1970-01-02', '1970-01-02'), { from: new Date(1970, 0, 2).getTime(), to: new Date(1970, 0, 3).getTime() });
  assert.ok(new Date(1970, 0, 2).getTime() >= 0);
});
