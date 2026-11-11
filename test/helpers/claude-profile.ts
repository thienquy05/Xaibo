// Temp Claude profile built from the synthetic 2.1.319 fixtures, plus a fresh store, for adapter tests.
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'claude', '2.1.319');

/** Copies fixture cases into `<tmp>/claude/projects/-tmp-xaibo-fixture-<case>/`. */
export async function claudeProfile(cases: string[]) {
  const tmp = mkdtempSync(join(tmpdir(), 'xclaude-'));
  const root = join(tmp, 'claude');
  for (const c of cases) {
    const dir = join(root, 'projects', `-tmp-xaibo-fixture-${c}`);
    mkdirSync(dir, { recursive: true });
    cpSync(join(FIXTURES, c), dir, { recursive: true, filter: (src) => !src.endsWith('expected.json') });
  }
  const store = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  store.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', ?, 'default')").run(root);
  return { tmp, root, db: store.db, writer: new Writer(store.db) };
}

export const count = (db: import('node:sqlite').DatabaseSync, sql: string, ...p: (string | number)[]) =>
  Number(Object.values(db.prepare(sql).get(...p) ?? {})[0]);

export async function until(cond: () => boolean, ms: number): Promise<number> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return performance.now() - t0;
}
