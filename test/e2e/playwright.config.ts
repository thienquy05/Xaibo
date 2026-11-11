// E2E (P1-T05): one worker (single-instance app, OS-level audit per launch); against `npm run dist:mac -- --dir`
// output. Text artifacts go through sanitize() (artifacts.ts; teardown.ts sanitizes Playwright's own text output);
// traces, screenshots and videos stay off because binary output cannot be sanitized (P1-T13).
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  globalTeardown: path.join(import.meta.dirname, 'teardown.ts'),
  outputDir: path.join(import.meta.dirname, '..', '..', 'test-results'),
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
