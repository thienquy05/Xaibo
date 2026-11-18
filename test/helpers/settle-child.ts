// XAIBO-PROD-513 (P5-T05, EC-103): a stand-in retention process. It expires the store's history in batches of 3 and, at
// batch 2, announces a point on stdout and blocks there until the parent SIGKILLs it: 'in-tx' after settle() and before
// the deletes (inside the transaction), or 'between' after the batch's COMMIT. Writes use writeSync so the line is out
// before the process blocks. Usage: settle-child.ts <db file> <secret hex> <in-tx|between>
import { writeSync } from 'node:fs';
import { openStore } from '../../src/service/store/db.ts';
import { expireBatch } from './monthly.ts';

const [file, secretHex, mode] = process.argv.slice(2) as [string, string, string];
const { db } = await openStore({ file, backupDir: `${file}.backups` });
const secret = Buffer.from(secretHex, 'hex');
const block = (point: string) => { writeSync(1, `${point}\n`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
for (let i = 0; ; i++) {
  const more = expireBatch(db, secret, 3, mode === 'in-tx' && i === 2 ? () => block('in-tx') : undefined);
  if (!more) break;
  if (mode === 'between' && i === 2) block('between');
}
writeSync(1, 'finished\n');
