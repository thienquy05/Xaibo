// Seeded synthetic Claude 2.1.319-shaped corpora for the perf suite (P1-T14; M3, EC-15). Synthetic only: made-up
// syllable words, the synthetic UUID pattern, /tmp/xaibo-fixture/ paths. Output under .cache/perf-corpus/ (git-ignored),
// plus summary.json with the actual sizes. Huge records are streamed to disk, never built in memory.
//   node scripts/gen-perf-corpus.ts --seed 1            T1: ~1,000 sessions, median ~200 KB, p99 ~20 MB, max ~200 MB
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

function t1() {
  const dir = path.join(ROOT, `t1-${seed}`);
  const claude = path.join(dir, '.claude', 'projects');
  const n = 1000;
  const sizes = Array.from({ length: n }, () => Math.min(8 * MiB, Math.max(8 * 1024, Math.round(170 * 1024 * Math.exp(0.9 * normal())))));
  for (let i = 0; i < 10; i++) sizes[1 + Math.floor(rand() * (n - 1))] = Math.round((5 + rand() * 15) * MiB); // ~p99: 5-20 MB
  sizes[0] = 200 * MiB; // the largest transcript
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

const name = values.case === 'ec15' ? `ec15-${seed}` : `t1-${seed}`;
rmSync(path.join(ROOT, name), { recursive: true, force: true });
const { dir, summary } = values.case === 'ec15' ? ec15() : t1();
writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
