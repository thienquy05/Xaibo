// Content-free logger (P1-T03; P4, EC-35): allowlisted fields only (event code, finite numbers, booleans, error codes,
// HMAC-hashed ids), every string through sanitize(), JSON lines in size-bounded rotating 0600 files in a 0700 dir.
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sanitize } from './sanitize.ts';

export type LogFields = Record<string, string | number | boolean | undefined>;
export interface Logger { log(event: string, fields?: LogFields): void }
export interface LoggerOptions { dir: string; secret: Buffer; maxBytes?: number; maxFiles?: number; now?: () => number }

const CODE = /^[A-Za-z0-9_.:-]{1,64}$/; // event names and error codes: never free text
const KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const STRING_KEYS = new Set(['error']);
const isIdKey = (k: string) => k === 'id' || k.endsWith('Id');

/** Opaque id for logs: HMAC-SHA256 with the per-install secret, truncated (OQ-X14). */
export const hashId = (secret: Buffer, id: string) => createHmac('sha256', secret).update(id).digest('hex').slice(0, 16);

/** The per-install random secret (32 bytes, 0600), created once; also used for P5 contribution keys (OQ-X14). */
export function loadInstallSecret(dir: string): Buffer {
  const file = path.join(dir, 'install-secret');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, randomBytes(32), { mode: 0o600 });
    try { linkSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } // first writer wins
    finally { rmSync(tmp, { force: true }); }
  }
  const secret = readFileSync(file);
  if (secret.length !== 32) throw new Error('install secret has the wrong size');
  return secret;
}

export function createLogger(o: LoggerOptions): Logger {
  const { dir, secret, maxBytes = 1 << 20, maxFiles = 3, now = Date.now } = o;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = path.join(dir, 'xaibo.log');
  const rotate = () => {
    rmSync(`${file}.${maxFiles - 1}`, { force: true });
    for (let i = maxFiles - 2; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    renameSync(file, `${file}.1`);
  };
  return {
    log(event, fields = {}) {
      const entry: Record<string, unknown> = { t: new Date(now()).toISOString(), event: CODE.test(event) ? event : 'invalid_event' };
      for (const [k, v] of Object.entries(fields)) {
        if (!KEY.test(k) || k === 't' || k === 'event') continue;
        if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') entry[k] = v;
        else if (typeof v === 'string' && isIdKey(k)) entry[k] = hashId(secret, v);
        else if (typeof v === 'string' && STRING_KEYS.has(k)) {
          const s = sanitize(v);
          if (CODE.test(s)) entry[k] = s; // an error code, or nothing
        }
      }
      const line = `${JSON.stringify(entry)}\n`;
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxBytes) rotate();
      // ponytail: synchronous append; logs are low-volume codes. Buffer writes if logging ever shows up in profiles.
      appendFileSync(file, line, { mode: 0o600 });
    },
  };
}
