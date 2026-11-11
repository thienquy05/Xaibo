// Playwright global teardown (P1-T13, EC-35): sanitize every text artifact the run left under test-results/.
import path from 'node:path';
import { sanitizeTree } from './artifacts.ts';

export default function teardown(): void {
  sanitizeTree(path.join(import.meta.dirname, '..', '..', 'test-results'));
}
