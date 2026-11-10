// S9 cleanup semantics (P0-S9-T6): plant synthetic transcripts in the TEMP Claude profile, then report survivors.
// Usage: node spikes/s9/plant-cleanup.ts plant|report
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.xaibo-spike-profiles', 'claude-a', 'home', '.claude', 'projects', '-tmp-xaibo-fixture-cleanup');
const DAY = 86_400_000;
const OLD = Date.now() - 10 * DAY;
// quadrant: [file mtime, last-record timestamp]
const CASES = { 1: ['old', 'old'], 2: ['old', 'new'], 3: ['new', 'old'], 4: ['new', 'new'] } as const;
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const t = (w: string) => (w === 'old' ? OLD : Date.now());

if (process.argv[2] === 'plant') {
  mkdirSync(ROOT, { recursive: true });
  for (const [n, [mtime, rec]] of Object.entries(CASES)) {
    const f = join(ROOT, `${id(Number(n))}.jsonl`);
    const line = (i: number) => JSON.stringify({ type: 'user', sessionId: id(Number(n)), uuid: `00000000-0000-4000-8000-0000000001${n}${i}`, timestamp: new Date(t(rec)).toISOString(), message: { role: 'user', content: 'synthetic' } });
    writeFileSync(f, `${line(0)}\n${line(1)}\n`);
    utimesSync(f, t(mtime) / 1000, t(mtime) / 1000);
  }
  const sub = join(ROOT, id(1), 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-0000000000000001.jsonl'), `${JSON.stringify({ type: 'user', isSidechain: true, timestamp: new Date(OLD).toISOString() })}\n`);
  utimesSync(join(sub, 'agent-0000000000000001.jsonl'), OLD / 1000, OLD / 1000);
  mkdirSync(join(ROOT, id(5)), { recursive: true }); // empty session dir
  console.log('planted');
} else {
  const present = (n: number) => existsSync(join(ROOT, `${id(n)}.jsonl`));
  console.log(JSON.stringify({
    survivors: Object.fromEntries(Object.entries(CASES).map(([n, [m, r]]) => [`${n}: mtime ${m}, last record ${r}`, present(Number(n))])),
    subagentFileSurvives: existsSync(join(ROOT, id(1), 'subagents', 'agent-0000000000000001.jsonl')),
    emptySessionDirSurvives: existsSync(join(ROOT, id(5))),
    projectDirEntries: existsSync(ROOT) ? readdirSync(ROOT).length : 0,
  }));
}
