// XAIBO-PROD-538/539: synthetic Agent Map fixtures shared by agent-map.spec.ts and visual.spec.ts: one-line Claude
// transcripts, the Codex simple-turn rollout moved to a cwd, and a git main checkout with a linked worktree laid out as
// git does (files only; no git command runs).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO } from './fixtures.ts';

const sid = (i: number) => `00000000-0000-4000-8000-00000000ac${String(i).padStart(2, '0')}`;
export function claude(home: string, i: number, cwd: string, prompt: string) {
  const dir = path.join(home, '.claude', 'projects', cwd.replaceAll('/', '-'));
  mkdirSync(dir, { recursive: true });
  const line = { parentUuid: null, type: 'user', uuid: `00000000-0000-4000-8000-00000000ce${String(i).padStart(2, '0')}`, timestamp: `2026-11-1${i % 10}T10:00:00.000Z`,
    cwd, sessionId: sid(i), entrypoint: 'cli', message: { role: 'user', content: prompt } };
  writeFileSync(path.join(dir, `${sid(i)}.jsonl`), `${JSON.stringify(line)}\n`);
}
/** The synthetic Codex simple-turn rollout with its cwd moved to `cwd`. */
export function codex(home: string, cwd: string) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const fixture = path.join(REPO, 'test', 'fixtures', 'synthetic', 'codex', '0.160.0', 'simple-turn');
  const name = readdirSync(fixture).find((f) => f.startsWith('rollout-'))!;
  writeFileSync(path.join(dir, name), readFileSync(path.join(fixture, name), 'utf8').replaceAll('/tmp/xaibo-fixture/alpha', cwd));
}
function gitDir(dir: string) {
  mkdirSync(path.join(dir, 'objects'), { recursive: true });
  mkdirSync(path.join(dir, 'refs'), { recursive: true });
  writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
}
/** example-app (main checkout) with a linked worktree example-app-docs, as git lays them out; no git command runs. */
export function repoLayout(root: string) {
  const main = path.join(root, 'example-app'), docs = path.join(root, 'example-app-docs'), admin = path.join(main, '.git', 'worktrees', 'docs');
  gitDir(path.join(main, '.git'));
  mkdirSync(admin, { recursive: true });
  mkdirSync(docs, { recursive: true });
  writeFileSync(path.join(admin, 'commondir'), '../..\n');
  writeFileSync(path.join(admin, 'gitdir'), `${path.join(docs, '.git')}\n`);
  writeFileSync(path.join(docs, '.git'), `gitdir: ${admin}\n`);
  return { main, docs };
}

