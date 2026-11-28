// XAIBO-PROD-617 (P7-T09; SEC1, FR-22): Open in VS Code. The URL is built only from a lowercase UUID session id, and
// allowedExternal() is the SEC1 shell.openExternal allowlist: exactly vscode://anthropic.claude-code/open?session=<uuid>, matched
// on the raw string (no other scheme, host, user, port, path, parameter or fragment; case-sensitive). openInVsCode hands that
// exact URL to an injected opener (main passes Electron's shell.openExternal when the UI lands, after the owner's mock review).
// Whether the handoff works for a session is a capability decision (S7, P7-T07), not this module's.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ID = new RegExp(`^${UUID}$`);
const ALLOWED = new RegExp(`^vscode://anthropic\\.claude-code/open\\?session=${UUID}$`);

export const vscodeUrl = (id: string): string | null => (ID.test(id) ? `vscode://anthropic.claude-code/open?session=${id}` : null);
export const allowedExternal = (url: string): boolean => ALLOWED.test(url);

export async function openInVsCode(id: string, openExternal: (url: string) => Promise<void>): Promise<'opened' | 'invalid' | 'failed'> {
  const url = vscodeUrl(id);
  if (url === null || !allowedExternal(url)) return 'invalid';
  try { await openExternal(url); return 'opened'; } catch { return 'failed'; } // the opener rejected
}
