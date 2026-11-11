// `npm run perf` (P1-T14): perf cases against the unpacked packaged app on seeded synthetic corpora (generate them with
// scripts/gen-perf-corpus.ts first). Prints aggregates as JSON, keeps a copy under .cache/perf/, exits 1 on a miss or a
// missing mark (Q19: the owner decides any miss).
//   npm run perf -- --tier T1 --metric m3-first-list --runs 20 [--seed 1] [--no-import]
//   npm run perf -- --case ec15 [--seed 1]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO } from './app.ts';
import { ec15Huge } from './ec15-huge.ts';
import { m3FirstList } from './m3-first-list.ts';

const { values } = parseArgs({ allowNegative: true, options: {
  tier: { type: 'string', default: 'T1' }, metric: { type: 'string' }, case: { type: 'string' }, runs: { type: 'string', default: '20' }, seed: { type: 'string', default: '1' },
  import: { type: 'boolean', default: true }, // --no-import skips the full-import timing run
} });
const corpusRoot = path.join(REPO, '.cache', 'perf-corpus');
const corpus = (name: string) => {
  const dir = path.join(corpusRoot, `${name}-${values.seed}`);
  if (!existsSync(path.join(dir, 'summary.json'))) throw new Error(`corpus ${name}-${values.seed} missing: node scripts/gen-perf-corpus.ts --seed ${values.seed}${name === 'ec15' ? ' --case ec15' : ''}`);
  return dir;
};

let result: { pass: boolean } & Record<string, unknown>;
if (values.case === 'ec15') result = await ec15Huge(corpus('ec15'));
else if (values.tier === 'T1' && values.metric === 'm3-first-list') result = { tier: 'T1', seed: Number(values.seed), ...await m3FirstList(corpus('t1'), Number(values.runs), values.import) };
else throw new Error('usage: --tier T1 --metric m3-first-list [--runs n] | --case ec15');

const out = path.join(REPO, '.cache', 'perf');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, `${values.case ?? values.metric}-${values.seed}-${Date.now()}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.pass ? 0 : 1;
