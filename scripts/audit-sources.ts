// Read-only format survey of agent session stores (P0-S9-T2; stdlib only, Node type stripping).
// Usage: audit-sources.ts [--claude-root <config>] [--codex-root <codex home>] [--gemini-root <.gemini dir>]
// Defaults (PRD App. F): ${CLAUDE_CONFIG_DIR:-~/.claude}, ${CODEX_HOME:-~/.codex}, ${GEMINI_CLI_HOME:-~}/.gemini.
// Without overrides it reads the real stores: owner-run only (P0-S9-T3). Prints aggregated counts as JSON;
// never paths, IDs, cwd, timestamps, content or per-file sizes. Never writes; exits 0 on any store content
// (non-zero only for usage errors: unknown flags, or some but not all root overrides).
import { closeSync, constants, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';

const MAX_LINE_BYTES = 16 * 1024 * 1024; // longer lines are counted as oversize and never buffered
const CHUNK_BYTES = 1024 * 1024;
const DISCRIMINATOR = /^[A-Za-z_][A-Za-z0-9_.-]{0,40}$/;
const ID_LIKE = /[0-9a-f]{8}/i; // UUID/hash/epoch runs pass DISCRIMINATOR when they start with a letter
// Pinned known top-level record types per version, from S9-T4 observation in temp profiles (phase0_spikes.md § S9).
// Codex keeps PRD §2.3's `compacted` (documented, not observed in Phase 0).
const KNOWN_TYPES = {
  claude: new Set(['user', 'assistant', 'system', 'attachment', 'api-request', 'api-request-blob', 'api-request-shape', 'atis-latch',
    'cost-state', 'last-prompt', 'mode', 'queue-operation', 'session-owner', 'tools-used']),
  codex: new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'token_usage_record', 'world_state', 'compacted']),
  gemini: undefined, // no pinned list: unknown share stays "unavailable"
};
type Agent = keyof typeof KNOWN_TYPES;

export function defaultRoots(env: NodeJS.ProcessEnv, home: string): Record<Agent, string> {
  return {
    claude: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    codex: env.CODEX_HOME || join(home, '.codex'),
    gemini: join(env.GEMINI_CLI_HOME || home, '.gemini'),
  };
}

const label = (v: unknown) => (typeof v === 'string' && DISCRIMINATOR.test(v) && !ID_LIKE.test(v) ? v : '<other>');
const hist = () => Object.create(null) as Record<string, number>; // no prototype: 'constructor' etc. are plain keys
const bump = (h: Record<string, number>, k: string) => { h[k] = (h[k] ?? 0) + 1; };
const sorted = (h: Record<string, number>) => Object.fromEntries(Object.entries(h).sort(([a], [b]) => a.localeCompare(b)));

function newStats() {
  return {
    files: 0, zstFiles: 0, unreadableFiles: 0, kinds: hist(),
    recordTypes: hist(), records: 0, unknownRecords: 0,
    lines: { partialTrailing: 0, malformed: 0, oversize: 0 },
  };
}
type Stats = ReturnType<typeof newStats>;

// Regular files under dir, at most `depth` directories down (lstat; symlinks are never followed).
// ponytail: in-root symlinks are skipped too; follow them with a realpath-under-root check if S9 finds any.
function walk(dir: string, depth = Infinity, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory()) { if (depth > 0) walk(p, depth - 1, out); }
    else if (st.isFile()) out.push(p);
  }
  return out;
}

// Manual chunk splitter: complete lines up to MAX_LINE_BYTES go to onLine; longer ones are skipped while reading.
function eachLine(file: string, s: Stats, onLine: (line: string) => void) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); // no symlink swapped in after lstat
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    let parts: Buffer[] = [], len = 0, over = false;
    for (let n; (n = readSync(fd, buf, 0, CHUNK_BYTES, null)) > 0;) {
      const chunk = buf.subarray(0, n);
      for (let start = 0; ;) {
        const nl = chunk.indexOf(10, start);
        const end = nl === -1 ? n : nl;
        if (!over && len + end - start > MAX_LINE_BYTES) { over = true; parts = []; len = 0; }
        if (!over) { parts.push(Buffer.from(chunk.subarray(start, end))); len += end - start; }
        if (nl === -1) break;
        if (over) s.lines.oversize++; else onLine(Buffer.concat(parts, len).toString('utf8'));
        parts = []; len = 0; over = false; start = nl + 1;
      }
    }
    if (over) s.lines.oversize++; else if (len > 0) s.lines.partialTrailing++;
  } finally {
    closeSync(fd);
  }
}

function scanJsonl(agent: Agent, file: string, s: Stats) {
  const kinds = new Set<string>();
  try {
    eachLine(file, s, (line) => {
      if (!line.trim()) return;
      let r;
      try { r = JSON.parse(line); } catch { s.lines.malformed++; return; }
      if (r === null || typeof r !== 'object' || Array.isArray(r)) { s.lines.malformed++; return; }
      const type = label(r.type);
      s.records++;
      bump(s.recordTypes, type);
      if (!KNOWN_TYPES[agent]?.has(type)) s.unknownRecords++;
      if (agent === 'claude' && r.entrypoint !== undefined) kinds.add(`entrypoint:${label(r.entrypoint)}`);
      if (agent === 'codex' && r.type === 'session_meta') {
        kinds.add(`source:${label(r.payload?.source)}`);
        kinds.add(`originator:${label(r.payload?.originator)}`);
      }
    });
  } catch {
    s.unreadableFiles++;
  }
  for (const k of kinds) bump(s.kinds, k); // counted once per file
}

function realRoot(p: string): string | undefined {
  try { return realpathSync(p); } catch { return undefined; }
}

function audit(agent: Agent, root: string) {
  const s = newStats();
  const extra: Record<string, number> = {};
  const real = realRoot(root);
  const scan = (files: string[]) => {
    for (const f of files) {
      if (f.endsWith('.jsonl')) { s.files++; scanJsonl(agent, f, s); }
      else if (f.endsWith('.jsonl.zst')) s.zstFiles++; // counted, never decompressed
    }
  };
  if (agent === 'claude') {
    const projects = real ? join(real, 'projects') : '';
    const files = real ? walk(projects) : [];
    scan(files);
    extra.subagentFiles = files.filter((f) => f.endsWith('.jsonl') && relative(projects, f).split(sep).includes('subagents')).length;
    extra.sessionsJsonFiles = real ? walk(join(real, 'sessions'), 0).filter((f) => f.endsWith('.json')).length : 0;
  } else if (agent === 'codex') {
    scan(real ? walk(join(real, 'sessions')) : []);
    const archived = real ? walk(join(real, 'archived_sessions')) : [];
    scan(archived);
    extra.archivedFiles = archived.filter((f) => f.endsWith('.jsonl')).length;
  } else {
    const tmp = real ? join(real, 'tmp') : '';
    const chats = (real ? walk(tmp, 2) : []).filter((f) => relative(tmp, f).split(sep)[1] === 'chats'); // tmp/*/chats/*
    scan(chats);
    extra.legacyJsonChats = chats.filter((f) => f.endsWith('.json')).length;
  }
  const known = KNOWN_TYPES[agent] !== undefined;
  return {
    files: s.files, ...extra, zstFiles: s.zstFiles, unreadableFiles: s.unreadableFiles,
    kinds: sorted(s.kinds), recordTypes: sorted(s.recordTypes), records: s.records,
    unknownRecords: known ? s.unknownRecords : 'unavailable',
    unknownShare: known && s.records > 0 ? Math.round((s.unknownRecords / s.records) * 1e4) / 1e4 : 'unavailable',
    lines: s.lines,
  };
}

if (import.meta.main) {
  const ROOT_FLAGS = ['claude-root', 'codex-root', 'gemini-root'] as const;
  const { values } = parseArgs({
    options: { 'claude-root': { type: 'string' }, 'codex-root': { type: 'string' }, 'gemini-root': { type: 'string' } },
  });
  const given = ROOT_FLAGS.filter((f) => values[f] !== undefined).length;
  if (given > 0 && given < ROOT_FLAGS.length) {
    // A partial override would silently read the other agents' real stores.
    console.error(`pass all of ${ROOT_FLAGS.join(', ')} or none`);
    process.exit(2);
  }
  const d = defaultRoots(process.env, homedir());
  console.log(JSON.stringify({
    claude: audit('claude', values['claude-root'] ?? d.claude),
    codex: audit('codex', values['codex-root'] ?? d.codex),
    gemini: audit('gemini', values['gemini-root'] ?? d.gemini),
  }, null, 2));
}
