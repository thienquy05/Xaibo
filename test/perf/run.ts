// `npm run perf` (P1-T14): perf cases against the unpacked packaged app on seeded synthetic corpora (generate them with
// scripts/gen-perf-corpus.ts first). Prints aggregates as JSON, keeps a copy under .cache/perf/, exits 1 on a miss or a
// missing mark (Q19: the owner decides any miss).
//   npm run perf -- --tier T1 --metric m3-first-list --runs 20 [--seed 1] [--no-import]
//   npm run perf -- --tier T1 --metric m3-full --runs 5 [--seed 1]   (P2-T14; mixed corpus from --case t1mix)
//   npm run perf -- --case ec15 [--seed 1]
//   npm run perf -- --tier T0 --only notify   (P3-T11; no corpus)
//   npm run perf -- --tier T0 --only live     (P3-T16a: M1, M11, M2 per path and missed-watch recovery; no corpus)
//   npm run perf -- --tier T0 --only tee --runs 200 [--packaged]   (P3-T14 dev / P3-T16b packaged tee added wait; no app, no corpus)
//   npm run perf -- --tier T1 --with-live-probes [--seed 1]   (P3-T16d: M1 and M2 per path while the t1mix corpus imports)
//   npm run perf -- --tier T0 --only m16 --runs 200   (P3-T16b: shim added wait and forwarder own time per fault mode)
//   npm run perf -- --tier T0 --only m4 [--seconds 300] [--seed 1]   (P3-T16b: idle footprint, window closed, on the T1 corpus)
//   npm run perf -- --tier T0 --only cold --runs 20 [--seed 1]   (P4-T13: M12 cold start, tray -> painted, M13 200 MB session; ec15 corpus)
//   npm run perf -- --tier TP [--seconds 600] [--seed 1]   (P4-T11: live load at the personal profile, t1mix backfill, service kill)
//   npm run perf -- --tier T2 [--seconds 600] [--seed 1]   (P4-T11 at plan scale: deferred scale-up stage only, D-P0-26/36)
//   npm run perf -- --tier M5 [--seconds 300] [--seed 1]   (P4-T17: M5 window open, 50 idle live sessions, Dashboard then workspace; M4 window closed)
//   npm run perf -- --tier TP --usage [--no-disk-full] [--seconds 600] [--seed 1]   (P4-T12b, EC-100: statusLine tee, Codex token_count, live
//     cost, disk-full fault, M4/M5/M7/M16 figures; mounts a disk image: run outside the command sandbox)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO } from './app.ts';
import { ec15Huge } from './ec15-huge.ts';
import { m3FirstList } from './m3-first-list.ts';
import { m3Full } from './m3-full.ts';
import { m16Probe, m4Probe } from './m16.ts';
import { m4m5Probe } from './m4-m5.ts';
import { coldStartProbe, importProbe, liveProbe, notifyProbe } from './t0.ts';
import { liveLoad } from './t2.ts';
import { teeWait } from './tee-wait.ts';

const { values } = parseArgs({ allowNegative: true, options: {
  tier: { type: 'string', default: 'T1' }, metric: { type: 'string' }, only: { type: 'string' }, case: { type: 'string' }, runs: { type: 'string', default: '20' }, seed: { type: 'string', default: '1' },
  import: { type: 'boolean', default: true }, // --no-import skips the full-import timing run
  packaged: { type: 'boolean', default: false }, seconds: { type: 'string' }, 'with-live-probes': { type: 'boolean', default: false },
  usage: { type: 'boolean', default: false }, 'disk-full': { type: 'boolean', default: true }, // --no-disk-full: usage without the volume
} });
const corpusRoot = path.join(REPO, '.cache', 'perf-corpus');
const corpus = (name: string) => {
  const dir = path.join(corpusRoot, `${name}-${values.seed}`);
  if (!existsSync(path.join(dir, 'summary.json'))) throw new Error(`corpus ${name}-${values.seed} missing: node scripts/gen-perf-corpus.ts --seed ${values.seed}${name === 't1' ? '' : ` --case ${name}`}`);
  return dir;
};

let result: { pass: boolean } & Record<string, unknown>;
if (values.case === 'ec15') result = await ec15Huge(corpus('ec15'));
else if (values.tier === 'T1' && values.metric === 'm3-first-list') result = { tier: 'T1', seed: Number(values.seed), ...await m3FirstList(corpus('t1'), Number(values.runs), values.import) };
else if (values.tier === 'T1' && values['with-live-probes']) result = { tier: 'T1', seed: Number(values.seed), ...await importProbe(corpus('t1mix')) };
else if (values.tier === 'T1' && values.metric === 'm3-full') result = { tier: 'T1', seed: Number(values.seed), ...await m3Full(corpus('t1mix'), Number(values.runs)) };
else if (values.tier === 'T0' && values.only === 'notify') result = { tier: 'T0', ...await notifyProbe() };
else if (values.tier === 'T0' && values.only === 'live') result = { tier: 'T0', ...await liveProbe() };
else if (values.tier === 'T0' && values.only === 'tee') result = { tier: 'T0', ...await teeWait(Number(values.runs), values.packaged) };
else if (values.tier === 'T0' && values.only === 'm16') result = { tier: 'T0', ...await m16Probe(Number(values.runs)) };
else if (values.tier === 'T0' && values.only === 'cold') result = { seed: Number(values.seed), ...await coldStartProbe(corpus('ec15'), Number(values.runs)) };
else if (values.tier === 'T0' && values.only === 'm4') result = { tier: 'T0', seed: Number(values.seed), ...await m4Probe(corpus('t1'), Number(values.seconds ?? '300')) };
else if (values.tier === 'M5') result = { tier: 'M5', seed: Number(values.seed), ...await m4m5Probe(corpus('t1mix'), Number(values.seconds ?? '300')) };
else if (values.tier === 'TP' || values.tier === 'T2') result = await liveLoad(values.tier, corpus('t1mix'), Number(values.seed), values.seconds ? Number(values.seconds) : undefined, values.usage, values['disk-full']);
else throw new Error('usage: --tier T1 --metric m3-first-list|m3-full [--runs n] | --tier T0 --only notify|live|tee|m16|m4|cold [--runs n] | --tier TP|T2 [--usage] [--seconds n] | --tier M5 [--seconds n] | --case ec15');

const out = path.join(REPO, '.cache', 'perf');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, `${values.case ?? values.metric ?? values.only ?? (values['with-live-probes'] ? 'live-import' : values.usage ? 'live-usage' : 'run')}-${values.seed}-${Date.now()}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.pass ? 0 : 1;
