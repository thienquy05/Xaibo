// XAIBO-PROD-322 (P3-T11a): a notification that cannot be shown is logged with a fixed code, never silently dropped.
// Electron 42+ shows macOS notifications through UNNotification, which refuses unsigned (ad-hoc) apps with a 'failed'
// event (Gate 3 live check, 2026-11-14). The title is never logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showNotification } from '../../src/main/notifications.ts';

type Logged = [string, Record<string, unknown> | undefined];

function fake(supported: boolean, fail: boolean) {
  const shown: string[] = [];
  class N {
    static isSupported() { return supported; }
    private failed?: () => void;
    private title: string;
    constructor(o: { title: string }) { this.title = o.title; }
    on(ev: 'failed', fn: () => void) { if (ev === 'failed') this.failed = fn; return this; }
    show() { shown.push(this.title); if (fail) this.failed?.(); }
  }
  return { N, shown };
}

const TITLE = 'Claude Code · Project · Waiting for permission';

test('a failed show logs one notify_failed with code show_failed and no title', () => {
  const { N, shown } = fake(true, true);
  const logged: Logged[] = [];
  showNotification(N, TITLE, (e, f) => logged.push([e, f]));
  assert.deepEqual(shown, [TITLE]);
  assert.deepEqual(logged, [['notify_failed', { error: 'show_failed' }]]);
  assert.ok(!JSON.stringify(logged).includes('Claude'));
});

test('an unsupported platform logs notify_failed with code unsupported and shows nothing', () => {
  const { N, shown } = fake(false, false);
  const logged: Logged[] = [];
  showNotification(N, TITLE, (e, f) => logged.push([e, f]));
  assert.deepEqual(shown, []);
  assert.deepEqual(logged, [['notify_failed', { error: 'unsupported' }]]);
});

test('a successful show logs nothing and shows the title once', () => {
  const { N, shown } = fake(true, false);
  const logged: Logged[] = [];
  showNotification(N, TITLE, (e, f) => logged.push([e, f]));
  assert.deepEqual(shown, [TITLE]);
  assert.deepEqual(logged, []);
});
