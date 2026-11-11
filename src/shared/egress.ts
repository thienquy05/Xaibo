// Egress registry (P1-T13, EC-35): every shipped path that carries data out of the private store, each with its
// canary test (`canary: <id>` in the named file; test/unit/egress-coverage.test.ts enforces it). MCP, OTLP and
// export join when they ship.
export const EGRESS = [
  { id: 'logs', what: 'app and service logs under <data>/logs: content-free codes, rotated, 0600', test: 'test/unit/log.test.ts' },
  { id: 'diagnostics', what: '"Save diagnostics…" bundle to a user-chosen file, sanitized, 0600', test: 'test/unit/diagnostics.test.ts' },
  { id: 'error-records', what: 'uncaught exceptions and rejections as error-code log entries; no crash reporter', test: 'test/unit/diagnostics.test.ts' },
  { id: 'test-artifacts', what: 'text written under test-results/, through sanitize(); no screenshots, videos or traces', test: 'test/unit/diagnostics.test.ts' },
] as const;
