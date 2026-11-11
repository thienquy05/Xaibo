// Path comparison (P1-T09, EC-16): originals are stored and shown as-is; comparisons use realpath + NFC.
import { realpathSync } from 'node:fs';

const realpathOrSelf = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };

export function cwdKey(cwd: string, realpath: (p: string) => string = realpathOrSelf): string {
  return realpath(cwd).normalize('NFC');
}
