// Perf trace ids (P3-T10, widened in P3-T16a): record ids come from untrusted files, so the test-only trace keeps only
// derived shapes, never content: UUIDs, Codex file identity + byte offset, agy line/step + content hash (review L2).
const TRACEABLE = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{16}:\d{1,15}$/, // Codex `${fileIdentity}:${offset}`
  /^(?:line|step):\d{1,15}:[0-9a-f]{16}$/, // agy
];
export const traceableIds = (ids: string[]) => ids.filter((x) => TRACEABLE.some((re) => re.test(x)));
