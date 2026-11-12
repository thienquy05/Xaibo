// Seeded synthetic Claude 2.1.319-shaped corpora for the perf suite (P1-T14; M3, EC-15). Synthetic only: made-up
// syllable words, the synthetic UUID pattern, /tmp/xaibo-fixture/ paths. Output under .cache/perf-corpus/ (git-ignored),
// plus summary.json with the actual sizes. Huge records are streamed to disk, never built in memory.
//   node scripts/gen-perf-corpus.ts --seed 1            T1: ~1,000 sessions, median ~200 KB, p99 ~20 MB, max ~200 MB
//   node scripts/gen-perf-corpus.ts --seed 1 --case t1mix  P2-T14 (OQ-P2-03): the T1 sizes split ~50% Claude / ~35% Codex 0.160.0 /
//     ~15% agy 1.5.6 by sessions; the 200 MB file and records above the parse cap stay Claude; the 5-20 MB files go to
//     Codex and agy (closer byte shares); ~5% of rollouts under archived_sessions/; agy with a history.jsonl
//   node scripts/gen-perf-corpus.ts --seed 1 --case ec15  20 MB file; 200 MB file with a 6 MiB and an 80 MiB record
//     (below and above the 8 MiB parse cap, D-P1-13) and 120 small, newer sessions imported first, so paging overlaps the import
import { closeSync, mkdirSync, openSync, rmSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { seed: { type: 'string', default: '1' }, case: { type: 'string', default: 't1' }, out: { type: 'string' } } });
const seed = Number(values.seed);
const ROOT = path.resolve(values.out ?? path.join(import.meta.dirname, '..', '.cache', 'perf-corpus'));
const MiB = 1 << 20;

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = mulberry32(seed);
const SYL = ['ka', 'lo', 'mi', 'ne', 'su', 'ta', 'ri', 'po', 've', 'zu', 'qa', 'jo', 'fi', 'de', 'bu', 'xo'];
const word = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => SYL[Math.floor(rand() * SYL.length)]).join('');
const words = (bytes: number) => { let s = ''; while (s.length < bytes) s += `${word()} `; return s.slice(0, bytes); };
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const BASE = Date.parse('2026-01-01T00:00:00.000Z');

let ids = 0x100000;

/** One transcript of about `size` bytes; `huge` records are streamed at evenly spaced points; `needle` ends the last. */
function writeTranscript(file: string, sessionId: string, size: number, start: number, huge: number[] = [], needle?: string): { bytes: number } {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, 'w');
  let bytes = 0;
  let t = start;
  let parent: string | null = null;
  let user = false;
  const head = (type: string) => {
    const id = uuid(ids++);
    const h = { parentUuid: parent, isSidechain: false, type, uuid: id, timestamp: new Date((t += 1000 + Math.floor(rand() * 60_000))).toISOString(),
      userType: 'external', entrypoint: 'cli', cwd: `/tmp/xaibo-fixture/p${sessionId.slice(-4)}`, sessionId, version: '2.1.319' };
    parent = id;
    return h;
  };
  const put = (s: string) => { writeSync(fd, s); bytes += Buffer.byteLength(s); };
  const line = (o: object) => put(`${JSON.stringify(o)}\n`);
  const marks = huge.map((len, i) => ({ len, at: Math.floor(((i + 1) * size) / (huge.length + 1)) }));
  while (bytes < size || marks.length) {
    if (marks.length && bytes >= marks[0]!.at) {
      const { len } = marks.shift()!;
      const h = JSON.stringify({ ...head('user'), message: { role: 'user', content: '' } });
      put(h.slice(0, -3)); // up to and including the empty content string's opening quote
      for (let left = len; left > 0; left -= MiB) put(words(Math.min(MiB, left)));
      if (needle && marks.length === 0) put(` ${needle}`);
      put('"}}\n');
      continue;
    }
    const text = words(1500 + Math.floor(rand() * 6000));
    user = !user;
    line(user ? { ...head('user'), message: { role: 'user', content: text } }
      : { ...head('assistant'), message: { model: 'claude-opus-5-5', id: `msg_${ids}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } });
  }
  closeSync(fd);
  const mtime = new Date(t);
  utimesSync(file, mtime, mtime); // in the past, so files are not all "live"
  return { bytes };
}

const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? 0; };

/** T1 sizes (§6.6): log-normal around ~170 KB, ten 5-20 MB files (~p99), one 200 MB file at index 0. */
function t1Sizes(n: number) {
  const sizes = Array.from({ length: n }, () => Math.min(8 * MiB, Math.max(8 * 1024, Math.round(170 * 1024 * Math.exp(0.9 * normal())))));
  const p99 = new Set<number>();
  for (let i = 0; i < 10; i++) { const at = 1 + Math.floor(rand() * (n - 1)); sizes[at] = Math.round((5 + rand() * 15) * MiB); p99.add(at); }
  sizes[0] = 200 * MiB; // the largest transcript
  return { sizes, p99 };
}

function t1() {
  const dir = path.join(ROOT, `t1-${seed}`);
  const claude = path.join(dir, '.claude', 'projects');
  const n = 1000;
  const { sizes } = t1Sizes(n);
  const files: number[] = [];
  let subagents = 0;
  let hugeRecords = 0;
  sizes.forEach((size, i) => {
    const sid = uuid(0x10000 + i);
    const proj = path.join(claude, `-tmp-xaibo-fixture-p${i % 40}`);
    const huge = i % 97 === 5 ? [8 * MiB] : [];
    hugeRecords += huge.length;
    files.push(writeTranscript(path.join(proj, `${sid}.jsonl`), sid, size, BASE + i * 3_600_000, huge).bytes);
    if (i % 20 === 3) {
      files.push(writeTranscript(path.join(proj, sid, 'subagents', `agent-${(0xa000 + i).toString(16)}.jsonl`), sid, Math.round(size / 4), BASE + i * 3_600_000).bytes);
      subagents++;
    }
  });
  return { dir, summary: { case: 't1', seed, sessions: n, files: files.length, subagents, hugeRecords, totalBytes: files.reduce((a, b) => a + b, 0),
    medianBytes: quantile(files, 0.5), p99Bytes: quantile(files, 0.99), maxBytes: Math.max(...files) } };
}

const stamp = (ms: number) => new Date(ms).toISOString();
function lineWriter(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, 'w');
  let bytes = 0;
  return { line: (o: object) => { const s = `${JSON.stringify(o)}\n`; writeSync(fd, s); bytes += Buffer.byteLength(s); }, get bytes() { return bytes; },
    close: (mtime: number) => { closeSync(fd); utimesSync(file, new Date(mtime), new Date(mtime)); return bytes; } };
}

/** A Codex 0.160.0 rollout (S9 shapes, as the synthetic fixtures): session_meta, then turns of turn_context, task_started,
 *  user and assistant messages, cumulative token_count and task_complete; thread settings applied after the first turn. */
function writeRollout(file: string, sid: string, size: number, start: number): number {
  const w = lineWriter(file);
  let t = start;
  let ord = 0;
  const ev = (type: string, payload: object) => w.line({ timestamp: stamp((t += 1000 + Math.floor(rand() * 30_000))), ordinal: ord++, type, payload });
  const cwd = `/tmp/xaibo-fixture/c${sid.slice(-4)}`;
  ev('session_meta', { id: sid, timestamp: stamp(t), cwd, originator: 'codex-tui', cli_version: '0.160.0', source: 'cli' });
  const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  for (let turn = 0; w.bytes < size; turn++) {
    const turnId = uuid(ids++);
    ev('turn_context', { turn_id: turnId, root_turn_id: turnId, cwd, current_date: '2026-01-01', approval_policy: 'synthetic-policy', sandbox_policy: { type: 'danger-full-access' },
      model: 'gpt-6.1-sol', collaboration_mode: { mode: 'default', settings: { model: 'gpt-6.1-sol', reasoning_effort: null, developer_instructions: null } } });
    ev('event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(t / 1000), model_context_window: 200000, collaboration_mode_kind: 'default' });
    ev('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: words(1500 + Math.floor(rand() * 6000)) }] });
    ev('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: words(1500 + Math.floor(rand() * 6000)) }] });
    const last = { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1200 };
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += last[k];
    ev('event_msg', { type: 'token_count', info: { total_token_usage: { ...total }, last_token_usage: last, model_context_window: 200000 } });
    if (turn === 0) ev('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol', service_tier: 'default', approval_policy: 'synthetic-policy' } });
    ev('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: 'synthetic reply', completed_at: Math.floor(t / 1000), duration_ms: 4000 });
  }
  return w.close(t);
}

/** An agy 1.5.6 transcript_full.jsonl (T00 schema): USER_INPUT, PLANNER_RESPONSE with usage, GENERIC tool output. */
function writeAgy(file: string, size: number, start: number): number {
  const w = lineWriter(file);
  let t = start;
  const types = ['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'PLANNER_RESPONSE'] as const;
  for (let step = 0; w.bytes < size; step++) {
    const type = types[step % types.length]!;
    w.line({ step_index: step, source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL', type, status: 'DONE', created_at: stamp((t += 1000 + Math.floor(rand() * 30_000))),
      ...(type === 'PLANNER_RESPONSE' ? { input_tokens: 1200, cache_read_tokens: 800, output_tokens: 40, tool_calls: [{ name: 'read_file', args: { Path: '/tmp/xaibo-fixture/agy/notes.txt' } }] } : {}),
      content: words(1500 + Math.floor(rand() * 6000)) });
  }
  return w.close(t);
}

function t1mix() {
  const dir = path.join(ROOT, `t1mix-${seed}`);
  const home = path.join(dir, 'home');
  const claude = path.join(home, '.claude', 'projects');
  const codex = path.join(home, '.codex');
  const agy = path.join(home, '.gemini', 'antigravity-cli');
  const n = 1000;
  const { sizes, p99 } = t1Sizes(n);
  const big = [...p99].sort((a, b) => a - b);
  const files: number[] = [];
  const bytes = { claude: 0, codex: 0, agy: 0 };
  const sessions = { claude: 0, codex: 0, agy: 0 };
  let subagents = 0;
  let hugeRecords = 0;
  let archived = 0;
  const history: string[] = [];
  sizes.forEach((size, i) => {
    const huge = i % 97 === 5 ? [8 * MiB] : [];
    const r = i % 20;
    const agent = i === 0 || huge.length ? 'claude' : p99.has(i) ? (big.indexOf(i) < 7 ? 'codex' : 'agy') : r < 10 ? 'claude' : r < 17 ? 'codex' : 'agy';
    const sid = uuid(0x10000 + i);
    const start = BASE + i * 3_600_000;
    let b: number;
    if (agent === 'claude') {
      const proj = path.join(claude, `-tmp-xaibo-fixture-p${i % 40}`);
      b = writeTranscript(path.join(proj, `${sid}.jsonl`), sid, size, start, huge).bytes;
      hugeRecords += huge.length;
      if (i % 20 === 3) {
        const sub = writeTranscript(path.join(proj, sid, 'subagents', `agent-${(0xa000 + i).toString(16)}.jsonl`), sid, Math.round(size / 4), start).bytes;
        files.push(sub);
        bytes.claude += sub;
        subagents++;
      }
    } else if (agent === 'codex') {
      const day = String(1 + (i % 28)).padStart(2, '0');
      const name = `rollout-2026-01-${day}T00-00-00-${sid}.jsonl`;
      const isArchived = rand() < 0.05;
      archived += isArchived ? 1 : 0;
      b = writeRollout(isArchived ? path.join(codex, 'archived_sessions', name) : path.join(codex, 'sessions', '2026', '01', day, name), sid, size, start);
    } else {
      b = writeAgy(path.join(agy, 'brain', sid, '.system_generated', 'logs', 'transcript_full.jsonl'), size, start);
      history.push(JSON.stringify({ display: words(40), timestamp: start, workspace: `/tmp/xaibo-fixture/a${sid.slice(-4)}`, conversationId: sid }));
    }
    files.push(b);
    bytes[agent] += b;
    sessions[agent]++;
  });
  writeFileSync(path.join(agy, 'history.jsonl'), `${history.join('\n')}\n`);
  const totalBytes = files.reduce((a, c) => a + c, 0);
  const share = (x: number) => Math.round((1000 * x) / totalBytes) / 10;
  return { dir, summary: { case: 't1mix', seed, sessions, files: files.length, subagents, hugeRecords, codexArchived: archived, bytes,
    bytePercent: { claude: share(bytes.claude), codex: share(bytes.codex), agy: share(bytes.agy) }, totalBytes,
    medianBytes: quantile(files, 0.5), p99Bytes: quantile(files, 0.99), maxBytes: Math.max(...files) } };
}

function ec15() {
  const dir = path.join(ROOT, `ec15-${seed}`);
  const small = writeTranscript(path.join(dir, 'small', '.claude', 'projects', '-tmp-xaibo-fixture-huge', `${uuid(0xe1501)}.jsonl`), uuid(0xe1501), 20 * MiB, BASE);
  const large = writeTranscript(path.join(dir, 'large', '.claude', 'projects', '-tmp-xaibo-fixture-huge', `${uuid(0xe1502)}.jsonl`), uuid(0xe1502), 200 * MiB, BASE,
    [6 * MiB, 80 * MiB], 'needleomega');
  for (let i = 0; i < 120; i++) { // small sessions so the list has pages to load during the import
    const sid = uuid(0xe1600 + i);
    writeTranscript(path.join(dir, 'large', '.claude', 'projects', '-tmp-xaibo-fixture-many', `${sid}.jsonl`), sid, 16 * 1024, BASE + 300 * 86_400_000 + (i + 1) * 60_000);
  }
  return { dir, summary: { case: 'ec15', seed, smallBytes: small.bytes, largeBytes: large.bytes, belowCapRecordBytes: 6 * MiB, aboveCapRecordBytes: 80 * MiB, extraSessions: 120 } };
}

const cases = { t1, t1mix, ec15 } as const;
const which = (values.case ?? 't1') as keyof typeof cases;
if (!cases[which]) throw new Error('--case t1 | t1mix | ec15');
rmSync(path.join(ROOT, `${which}-${seed}`), { recursive: true, force: true });
const { dir, summary } = cases[which]();
writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
