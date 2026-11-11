// E2E (P1-T05): one worker (single-instance app, OS-level audit per launch); against `npm run dist:mac -- --dir`
// output. Traces, screenshots and videos stay off until P1-T13 routes test artifacts through sanitize().
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  outputDir: path.join(import.meta.dirname, '..', '..', 'test-results'),
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
