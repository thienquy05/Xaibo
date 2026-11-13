// `npm run perf` (P1-T14): perf cases against the unpacked packaged app on seeded synthetic corpora (generate them with
// scripts/gen-perf-corpus.ts first). Prints aggregates as JSON, keeps a copy under .cache/perf/, exits 1 on a miss or a
// missing mark (Q19: the owner decides any miss).
//   npm run perf -- --tier T1 --metric m3-first-list --runs 20 [--seed 1] [--no-import]
//   npm run perf -- --tier T1 --metric m3-full --runs 5 [--seed 1]   (P2-T14; mixed corpus from --case t1mix)
//   npm run perf -- --case ec15 [--seed 1]
//   npm run perf -- --tier T0 --only notify   (P3-T11; no corpus)
//   npm run perf -- --tier T0 --only live     (P3-T16a: M1, M11, M2 per path and missed-watch recovery; no corpus)
//   npm run perf -- --tier T0 --only tee --runs 200 [--packaged]   (P3-T14 dev / P3-T16b packaged tee added wait; no app, no corpus)
//   npm run perf -- --tier T0 --only m16 --runs 200   (P3-T16b: shim added wait and forwarder own time per fault mode)
//   npm run perf -- --tier T0 --only m4 [--seconds 300] [--seed 1]   (P3-T16b: idle footprint, window closed, on the T1 corpus)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO } from './app.ts';
import { ec15Huge } from './ec15-huge.ts';
import { m3FirstList } from './m3-first-list.ts';
import { m3Full } from './m3-full.ts';
import { m16Probe, m4Probe } from './m16.ts';
import { liveProbe, notifyProbe } from './t0.ts';
import { teeWait } from './tee-wait.ts';

const { values } = parseArgs({ allowNegative: true, options: {
  tier: { type: 'string', default: 'T1' }, metric: { type: 'string' }, only: { type: 'string' }, case: { type: 'string' }, runs: { type: 'string', default: '20' }, seed: { type: 'string', default: '1' },
  import: { type: 'boolean', default: true }, // --no-import skips the full-import timing run
  packaged: { type: 'boolean', default: false }, seconds: { type: 'string', default: '300' },
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
else if (values.tier === 'T1' && values.metric === 'm3-full') result = { tier: 'T1', seed: Number(values.seed), ...await m3Full(corpus('t1mix'), Number(values.runs)) };
else if (values.tier === 'T0' && values.only === 'notify') result = { tier: 'T0', ...await notifyProbe() };
else if (values.tier === 'T0' && values.only === 'live') result = { tier: 'T0', ...await liveProbe() };
else if (values.tier === 'T0' && values.only === 'tee') result = { tier: 'T0', ...await teeWait(Number(values.runs), values.packaged) };
else if (values.tier === 'T0' && values.only === 'm16') result = { tier: 'T0', ...await m16Probe(Number(values.runs)) };
else if (values.tier === 'T0' && values.only === 'm4') result = { tier: 'T0', seed: Number(values.seed), ...await m4Probe(corpus('t1'), Number(values.seconds)) };
else throw new Error('usage: --tier T1 --metric m3-first-list|m3-full [--runs n] | --tier T0 --only notify|live|tee|m16|m4 [--runs n] | --case ec15');

const out = path.join(REPO, '.cache', 'perf');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, `${values.case ?? values.metric ?? values.only}-${values.seed}-${Date.now()}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.pass ? 0 : 1;
