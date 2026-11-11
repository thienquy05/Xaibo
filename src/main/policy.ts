// Pure parts of the P2/SEC1 policy (P1-T04); src/main/security.ts wires them into Electron. No Electron import here,
// so node:test covers them directly.
import path from 'node:path';

export const CSP = "default-src 'self'; connect-src 'self'";
export const APP_ORIGIN = 'app://xaibo';
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

/** The Vite dev origin, only for an unpackaged app and only on a loopback IP. */
export function devOrigin(env: Record<string, string | undefined>, packaged: boolean): string | undefined {
  if (packaged || !env.XAIBO_DEV_SERVER_URL) return undefined;
  try {
    const u = new URL(env.XAIBO_DEV_SERVER_URL);
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname) ? u.origin : undefined;
  } catch { return undefined; }
}

/** Deny by default: app: and devtools:, plus the dev origin over http and its HMR socket over ws. */
export function isAllowedRequest(url: string, dev?: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'app:' || u.protocol === 'devtools:') return true;
  if (!dev) return false;
  return (u.protocol === 'http:' || u.protocol === 'ws:') && u.host === new URL(dev).host;
}

/** Maps app://xaibo/<path> to a file under root, or null for any other host or a path that leaves root. */
export function resolveAppFile(root: string, url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (`${u.protocol}//${u.host}` !== APP_ORIGIN) return null;
  let rel: string;
  try { rel = decodeURIComponent(u.pathname); } catch { return null; }
  if (rel.includes('\0')) return null;
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, rel);
  return file.startsWith(root + path.sep) ? file : null;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
export const contentType = (file: string) => TYPES[path.extname(file)] ?? 'application/octet-stream';
