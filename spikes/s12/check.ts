// S12 threshold check (P0-S12-T1). Reads the reduced evidence and exits 1 on any miss or missing file.
//   corpus.json (T2): personal profile (owner decision 2026-11-10): >= 1 GiB populated DB, >= 1,500 sessions,
//                     a 50 MB session, both integrity checks ok.
//   load.json (T4):   { runs: [{ arch, mix, queueAgeP95Ms, drainMs, lost, duplicated }] }; every run is judged,
//                     the plan's "smallest passing variant" is read off the per-run lines.
// Usage: node spikes/s12/check.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EV = join(import.meta.dirname, 'evidence');
const GIB = 2 ** 30;
const T4 = { queueAgeP95Ms: 1000, drainMs: 5000 }; // M14: queue age p95 <= 1 s, drain <= 5 s, loss/dup 0

const read = (f: string): any => (existsSync(join(EV, f)) ? JSON.parse(readFileSync(join(EV, f), 'utf8')) : undefined);
let failed = false;
const say = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };

const c = read('corpus.json');
if (!c) say(false, 'corpus.json missing (run --build)');
else {
  say(c.db.bytes >= GIB, `corpus DB ${(c.db.bytes / GIB).toFixed(2)} GiB >= 1 GiB`);
  say(c.rows.sessions >= 1_500, `sessions ${c.rows.sessions} >= 1500`);
  say(c.generator.sessions.maxBytes === 50e6 && c.generator.sessions.atMax >= 1, `sessions at 50 MB: ${c.generator.sessions.atMax}`);
  say(c.verify.integrity === 'ok' && c.verify.ftsIntegrity === true, 'integrity_check and FTS integrity-check');
}

const l = read('load.json');
if (!l?.runs?.length) say(false, 'load.json missing or empty (run --load, T4)');
else for (const r of l.runs) {
  // A missing measurement fails (null <= 1000 is true in JavaScript, so check the type first).
  const ok = (x: unknown, max: number) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max;
  say(ok(r.queueAgeP95Ms, T4.queueAgeP95Ms) && ok(r.drainMs, T4.drainMs) && r.lost === 0 && r.duplicated === 0,
    `load ${r.arch}/${r.mix}: queue age p95 ${r.queueAgeP95Ms} ms, drain ${r.drainMs} ms, lost ${r.lost}, dup ${r.duplicated}`);
}
process.exitCode = failed ? 1 : 0;
