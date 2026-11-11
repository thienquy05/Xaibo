// P0-S13-T1 statusLine probe (spike only; temp profiles). Reads stdin fully, appends one JSON line to
// $XAIBO_SPIKE_RAW/statusline.jsonl describing HOW it was invoked (no values: env names only, key paths and JSON types
// only; model.id, model.display_name and effort.level kept when identifier-like, else <other>), prints XAIBO-PROBE
// and exits 0. XAIBO_PROBE_SLEEP_MS keeps it alive after printing; a second line records {signal} on SIGTERM/SIGINT/
// SIGHUP, or {signal: null} if the sleep completed (no second line = SIGKILL) (App. E #22).
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:os';
import { basename, join, sep } from 'node:path';
import { reduce } from '../shared/reduce.ts';

const VALUE_PATHS = new Set(['model.id', 'model.display_name', 'effort.level']);
const raw = process.env.XAIBO_SPIKE_RAW;
const append = (rec) => {
  if (!raw) return;
  try { appendFileSync(join(raw, 'statusline.jsonl'), `${JSON.stringify({ ts_mono_ns: process.hrtime.bigint().toString(), ts_wall_ms: Date.now(), ...rec })}\n`, { mode: 0o600 }); } catch { /* never disturb Claude */ }
};

function parentComm() {
  try {
    const c = basename(execFileSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim());
    return /^[A-Za-z0-9_.+-]{1,40}$/.test(c) ? c : '<other>';
  } catch { return 'unavailable'; }
}

function shape(text) {
  let payload;
  try { payload = JSON.parse(text); } catch { return { json: text.length ? 'invalid' : 'empty' }; }
  const keys = reduce([{ event: 'statusline', payload }], ['id', 'display_name', 'level']).statusline?.keys ?? {};
  const key_types = {}; const values = {};
  for (const [path, st] of Object.entries(keys)) {
    key_types[path] = st.types;
    if (VALUE_PATHS.has(path) && st.values) values[path] = st.values.map((v) => (v === '<id>' ? '<other>' : v));
  }
  return { json: 'ok', key_types, values };
}

const chunks = [];
const done = () => {
  const stdin = Buffer.concat(chunks);
  append({
    kind: 'invocation',
    stdin_bytes: stdin.length,
    stdin_is_tty: Boolean(process.stdin.isTTY),
    argv_count: process.argv.length - 2,
    parent_comm: parentComm(),
    cwd_category: process.cwd().split(sep).includes('spike-projects') ? 'project' : 'other',
    env_names: Object.keys(process.env).sort(),
    ...shape(stdin.toString('utf8')),
  });
  process.stdout.write('XAIBO-PROBE\n');
  const sleepMs = Number(process.env.XAIBO_PROBE_SLEEP_MS) || 0;
  if (!sleepMs) return;
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(s, () => { append({ kind: 'signal', signal: s }); process.exit(128 + constants.signals[s]); });
  }
  setTimeout(() => append({ kind: 'signal', signal: null }), sleepMs);
};
if (process.stdin.isTTY) done();
else { process.stdin.on('data', (c) => chunks.push(c)); process.stdin.on('end', done); }
