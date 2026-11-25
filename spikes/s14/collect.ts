// P6-S14-T1 collection over APPROVED disposable-profile outputs only (design "Guard and privacy procedure" 7-8):
//   settings <label>    clears that label's earlier captures, writes the --settings file naming capture.ts; prints its path.
//   reduce <agent> <slot> <method> <label...>
//                       classifies the run's captures (Claude) or rollouts (Codex) with the draft candidate rules and
//                       merges numberless rows into evidence/s14.json. Bounded reads of regular files; no recursive
//                       profile crawl, no config/auth/environment read. Raw captures stay in the git-ignored .cache.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { keyPaths } from './capture.ts';
import { classify, VERSION, type Method, type Rule, type Source } from './signals.ts';
import { keyNames, serialize, type Row } from './report.ts';

const FILE_CAP = 8 << 20;
const REPO = join(import.meta.dirname, '..', '..');
const RAW = process.env.XAIBO_SPIKE_RAW ?? join(REPO, '.cache', 'spike-results', 's14', 'raw'); // the runner sets it for capture
const EVIDENCE = process.env.XAIBO_S14_EVIDENCE ?? join(import.meta.dirname, 'evidence', 's14.json'); // override: smoke tests only
type Agent = 'claude' | 'codex' | 'agy';
const SURFACE: Record<Agent, Source> = { claude: 'claude-statusline', codex: 'codex-rollout', agy: 'agy-transcript' };
// D-P6-14: live = Claude subscription only; everything else is ready but recorded not-run (no access), never unsupported.
const PLANNED: [Agent, string][] = [
  ['claude', 'subscription'], ['claude', 'api-key'], ['claude', 'cloud-provider'], ['claude', 'gateway'], ['claude', 'mixed'],
  ['codex', 'subscription'], ['codex', 'api-key'], ['codex', 'cloud-provider'], ['codex', 'gateway'], ['agy', 'google-sign-in'],
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** dir's realpath lies inside parent's: a symlinked collection root never leads out of the profile (review 3). */
export function under(parent: string, dir: string): boolean {
  try { return realpathSync(dir).startsWith(realpathSync(parent) + sep); } catch { return false; }
}

/** Lines of a regular file whose realpath is inside root, at most maxBytes; larger is truncated (invalid coverage). */
export function readBounded(root: string, file: string, maxBytes: number): { lines: string[]; truncated: boolean } {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || !realpathSync(file).startsWith(realpathSync(root) + sep)) return { lines: [], truncated: false };
    if (st.size > maxBytes) return { lines: [], truncated: true };
    return { lines: readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== ''), truncated: false };
  } catch { return { lines: [], truncated: false }; }
}

export interface Run { agent: Agent; version: string; method: Method | 'google-sign-in'; rules: Rule[]; starts: string[][]; guard: 'MATCH' | 'DIFF'; truncated: boolean }

/** One row per candidate rule: present/absent over the starts, repeatable only when every start shows it. */
export function rowsFor(run: Run): Row[] {
  const surface = SURFACE[run.agent];
  const base = { agent: run.agent, version: run.version, method: run.method, surface };
  const status = (present: boolean, repeatable: string) =>
    run.truncated ? { result: 'invalid', reason: 'collection-truncated' }
      : run.guard !== 'MATCH' ? { result: 'invalid', reason: 'guard-diff' }
        : run.starts.length === 0 || run.starts.some((s) => s.length === 0) ? { result: 'invalid', reason: 'collection-empty' } // review 1
        : !VERSION.test(run.version) ? { result: 'invalid', reason: 'version-changed' }
          : !present ? { result: 'negative', reason: 'signal-absent' }
            : repeatable === 'yes' ? { result: 'verified', reason: 'alternatives-not-run' } : { result: 'negative', reason: 'not-repeatable' };
  if (run.rules.length === 0) {
    const s = status(false, 'unavailable');
    return [{ ...base, fields: [], predicate: null, signal: 'absent', repeatable: 'unavailable', result: s.result, guard: run.guard, reachable: 'yes',
      reason: s.result === 'negative' ? 'no-candidate' : s.reason }];
  }
  return run.rules.map((rule) => {
    const r = { ...rule, version: run.version };
    const hit = run.starts.map((s) => classify(s.map((raw) => ({ source: r.source, version: run.version, raw })), [r]).method !== 'unknown');
    const present = hit.some(Boolean);
    const repeatable = !present || run.starts.length < 2 ? 'unavailable' : hit.every(Boolean) ? 'yes' : 'no';
    const s = status(present, repeatable);
    return { ...base, fields: [rule.field], predicate: rule.id, signal: present ? 'present' : 'absent', repeatable, result: s.result, guard: run.guard, reachable: 'yes', reason: s.reason };
  });
}

function versionOf(profile: string, starts: number): string {
  const log = readBounded(profile, join(profile, 'versions.log'), 1 << 20).lines.slice(-starts);
  const vs = log.flatMap((l) => l.split('\t').slice(1)).map((v) => /\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?/.exec(v)?.[0] ?? '');
  return log.length === starts && vs.length && vs.every((v) => v && v === vs[0]) ? vs[0]! : 'unavailable';
}

function reduce(agent: Agent, slot: string, method: Method, labels: string[]) {
  const profile = join(homedir(), '.xaibo-spike-profiles', agent + '-' + slot);
  const draft = JSON.parse(readFileSync(join(import.meta.dirname, 'catalog-signals.draft.json'), 'utf8')) as { rules: Rule[] };
  const rules = draft.rules.filter((r) => r.source === SURFACE[agent]);
  const keys: Record<string, string[]> = {};
  let truncated = false;
  const lines = (root: string, file: string) => { const r = readBounded(root, file, FILE_CAP); truncated ||= r.truncated; return r.lines; };
  const json = (l: string): unknown => { try { return JSON.parse(l); } catch { return undefined; } };
  let starts: string[][] = [];
  if (agent === 'claude') {
    starts = labels.map((label) => lines(RAW, join(RAW, label, 'statusline.jsonl')).flatMap((l) => {
      const c = json(l);
      if (!isObj(c)) return [];
      (keys['claude-statusline'] ??= []).push(...(Array.isArray(c.keys) ? c.keys.map(String) : []));
      return [JSON.stringify(c.record)];
    }));
    // Claude transcripts of the throwaway project: key names only (no candidate rule: design table).
    const projects = join(profile, 'home', '.claude', 'projects');
    for (const d of under(profile, projects) ? readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()) : []) {
      const names = readdirSync(join(projects, d.name)).filter((n) => n.endsWith('.jsonl'));
      if (names.length > 64) truncated = true;
      for (const f of names.slice(0, 64)) {
        (keys['claude-transcript'] ??= []).push(...lines(projects, join(projects, d.name, f)).flatMap((l) => keyPaths(json(l))));
      }
    }
  } else if (agent === 'codex') {
    // One rollout file per codex exec start; any other count is collection-empty (ponytail: assumes a fresh profile).
    const sessions = join(profile, 'home', '.codex', 'sessions');
    const files = under(profile, sessions) ? readdirSync(sessions, { recursive: true }).map(String).filter((f) => /rollout-[^/]*\.jsonl$/.test(f)).sort() : [];
    starts = files.length === labels.length ? files.map((f) => lines(sessions, join(sessions, f))) : labels.map(() => []);
    keys['codex-rollout'] = starts.flat().flatMap((l) => keyPaths(json(l)));
  } else throw new Error('reduce: claude or codex');
  const version = versionOf(profile, labels.length);
  const live = rowsFor({ agent, version, method, rules, starts, guard: 'MATCH', truncated });
  const prev = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) as { rows: Row[]; keys: Record<string, string[]> } : { rows: [], keys: {} };
  const kept = prev.rows.filter((r) => typeof r.agent === 'string' && !(r.agent === agent && r.method === method) && r.result !== 'not-run');
  const done = new Set([...kept, ...live].map((r) => r.agent + ':' + r.method));
  const notRun = PLANNED.filter(([a, m]) => !done.has(a + ':' + m)).map(([a, m]) => ({ agent: a, version: 'unavailable', method: m, surface: SURFACE[a], fields: [],
    predicate: null, signal: 'unavailable', repeatable: 'unavailable', result: 'not-run', guard: 'not-run', reachable: 'unavailable', reason: 'no-access' }));
  const mergedKeys = { ...prev.keys, ...Object.fromEntries(Object.entries(keys).map(([s, k]) => [s, keyNames(k)])) };
  mkdirSync(join(EVIDENCE, '..'), { recursive: true });
  writeFileSync(EVIDENCE, JSON.stringify({ rows: JSON.parse(serialize([...kept, ...live, ...notRun])), keys: mergedKeys }, null, 2) + '\n');
  for (const r of JSON.parse(serialize(live)) as Row[]) console.log([r.agent, r.version, r.method, r.predicate ?? '-', r.signal, r.repeatable, r.result, r.reason].join(' | '));
}

function main(argv: string[]) {
  const [cmd, ...a] = argv;
  if (cmd === 'settings' && /^[A-Za-z0-9-]{1,64}$/.test(a[0] ?? '')) {
    const file = join(RAW, a[0] + '.settings.json');
    const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    rmSync(join(RAW, a[0]!), { recursive: true, force: true }); // a rerun never reuses an earlier attempt's captures (review 2)
    mkdirSync(RAW, { recursive: true });
    const argv = [process.execPath, '--disable-warning=ExperimentalWarning', join(import.meta.dirname, 'capture.ts'), a[0]!];
    writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: argv.map(q).join(' ') } }) + '\n');
    console.log(file);
    return 0;
  }
  if (cmd === 'reduce' && a.length >= 4) { reduce(a[0] as Agent, a[1]!, a[2] as Method, a.slice(3)); return 0; }
  console.error('usage: collect.ts settings <label> | reduce <claude|codex> <slot> <method> <label...>');
  return 2;
}
if (import.meta.main) process.exitCode = main(process.argv.slice(2));
