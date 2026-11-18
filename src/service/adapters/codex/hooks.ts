// Codex hooks (P3-T06; FR-31, S5). The 0.160.0 event set Xaibo subscribes to (no model-request events exist there,
// S5 2.6; EC-53 leaves them to the catalog's capability detection) and the events S5 saw accept `async: true`
// (SessionEnd runs synchronously, so it stays sync). Payloads are mapped to evidence by status-map.ts.
export const CODEX_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact',
  'PostCompact', 'UserPromptSubmit', 'Stop', 'Interrupt',
] as const;
export const CODEX_ASYNC_EVENTS: readonly string[] = ['SessionStart', 'PostToolUse'];
