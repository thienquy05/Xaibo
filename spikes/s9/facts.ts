// S9 fact extraction (P0-S9-T4) over the TEMP profiles only. Emits booleans, key sets, allowlisted discriminator
// values and filename patterns (IDs replaced); never content, IDs, paths or timestamps. Usage: node spikes/s9/facts.ts
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { reduce } from '../shared/reduce.ts';

const P = join(homedir(), '.xaibo-spike-profiles');
const CLAUDE = join(P, 'claude-a', 'home', '.claude');
const CODEX = join(P, 'codex-a', 'home', '.codex');
const OUT = join(import.meta.dirname, 'evidence');
const SCHEMAS = join(import.meta.dirname, 'schemas');
const IDENT = /^[A-Za-z_][A-Za-z0-9_.-]{0,40}$/;
const LARGE_FIELD_BYTES = 4096;

type Rec = Record<string, any>;
const files = (root: string, re: RegExp) => (existsSync(root) ? readdirSync(root, { recursive: true }).map(String).filter((f) => re.test(f)).map((f) => join(root, f)) : []);
const lines = (f: string): Rec[] => readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Rec]; } catch { return []; } });
const vals = (xs: unknown[]) => [...new Set(xs.filter((x): x is string => typeof x === 'string').map((x) => (IDENT.test(x) ? x : '<other>')))].sort();
const keys = (xs: unknown[]) => [...new Set(xs.flatMap((x) => (x && typeof x === 'object' ? Object.keys(x) : [])))].sort();
const pattern = (rel: string) => rel
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/g, '<ts>')
  .replace(/\/\d{4}\/\d{2}\/\d{2}\//g, '/<yyyy>/<mm>/<dd>/')
  .replace(/agent-[0-9a-f]{8,}/g, 'agent-<id>')
  .replace(/^projects\/[^/]+/, 'projects/<encoded-cwd>');

function largeFields(recs: Rec[]) {
  const big = new Set<string>();
  const walk = (v: unknown, at: string) => {
    if (typeof v === 'string' && v.length > LARGE_FIELD_BYTES) big.add(at);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, `${at}[]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${IDENT.test(k) ? k : '<key>'}` : k);
  };
  recs.forEach((r) => walk(r, ''));
  return [...big].sort();
}

function claudeFacts() {
  const tfiles = files(join(CLAUDE, 'projects'), /\.jsonl$/);
  const recs = tfiles.flatMap(lines);
  const assistants = recs.filter((r) => r.type === 'assistant' && r.message?.id);
  const byMsg = new Map<string, Rec[]>();
  for (const r of assistants) byMsg.set(r.message.id, [...(byMsg.get(r.message.id) ?? []), r]);
  const multi = [...byMsg.values()].filter((g) => g.length > 1);
  const compact = recs.filter((r) => r.type === 'system' && /compact/i.test(String(r.subtype)));
  const userText = recs.filter((r) => r.type === 'user' && typeof r.message?.content === 'string').map((r) => r.message.content as string);
  const sessionsJson = files(join(CLAUDE, 'sessions'), /\.json$/);
  return {
    version: '2.1.319',
    transcriptPathPatterns: [...new Set(tfiles.map((f) => pattern(relative(CLAUDE, f))))].sort(),
    identifiers: { sessionId: recs.some((r) => 'sessionId' in r), uuid: recs.some((r) => 'uuid' in r), parentUuid: recs.some((r) => 'parentUuid' in r) },
    recordTypes: vals(recs.map((r) => r.type)),
    systemSubtypes: vals(recs.filter((r) => r.type === 'system').map((r) => r.subtype)),
    entrypoints: vals(recs.map((r) => r.entrypoint)),
    userTypes: vals(recs.map((r) => r.userType)),
    contentBlockTypes: vals(recs.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content.map((c: Rec) => c?.type) : []))),
    models: vals(assistants.map((r) => r.message.model)),
    usageKeys: keys(assistants.map((r) => r.message.usage)),
    cacheCreationKeys: keys(assistants.map((r) => r.message.usage?.cache_creation)),
    partialUpdates: {
      messageIdsWithSeveralLines: multi.length > 0,
      usageIdenticalAcrossLines: multi.length ? multi.every((g) => g.every((r) => JSON.stringify(r.message.usage) === JSON.stringify(g[0].message.usage))) : null,
      outputTokensNonDecreasing: multi.length ? multi.every((g) => g.every((r, i) => i === 0 || (r.message.usage?.output_tokens ?? 0) >= (g[i - 1].message.usage?.output_tokens ?? 0))) : null,
    },
    subagent: { sidechainRecords: recs.some((r) => r.isSidechain === true), subagentFilePatterns: [...new Set(tfiles.filter((f) => /subagent|agent-/.test(f)).map((f) => pattern(relative(CLAUDE, f))))].sort() },
    compaction: { recorded: compact.length > 0, subtypes: vals(compact.map((r) => r.subtype)), metadataKeys: keys(compact.map((r) => r.compactMetadata)) },
    injectedPrefixes: [...new Set(userText.map((t) => /^<[a-z-]+>/.exec(t)?.[0]).filter((x): x is string => !!x))].sort(),
    largePayloadFields: largeFields(recs),
    sessionsJson: { present: sessionsJson.length > 0, keys: keys(sessionsJson.map((f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } })) },
    zstFiles: files(CLAUDE, /\.zst$/).length > 0,
  };
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const textOf = (content: unknown) => (Array.isArray(content) ? flat(content.map((c: Rec) => (typeof c?.text === 'string' ? c.text : '')).join(' ')) : '');
const ITEM_ROLE: Record<string, string> = { UserMessage: 'user', AgentMessage: 'assistant' };

/** Do event_msg item_completed User/AgentMessage items mirror response_item messages (same file, role, text)? Booleans only. */
export function mirroring(perFile: Rec[][]) {
  let items = 0, user = 0, agent = 0, matched = 0, idPairs = 0;
  let userOk = true, agentOk = true, after = true, idsEqual = true, userNoItem = false, assistantNoItem = false;
  for (const recs of perFile) {
    const resps = recs.flatMap((r, i) => (r.type === 'response_item' && r.payload?.type === 'message' && (r.payload.role === 'user' || r.payload.role === 'assistant')
      ? [{ i, role: r.payload.role as string, text: textOf(r.payload.content), id: r.payload.id, used: false }] : []));
    recs.forEach((r, i) => {
      const it = r.type === 'event_msg' && r.payload?.type === 'item_completed' ? r.payload.item : undefined;
      const role = ITEM_ROLE[it?.type];
      if (!role) return;
      items++;
      if (role === 'user') user++; else agent++;
      const text = textOf(it.content);
      const m = resps.find((x) => !x.used && x.role === role && x.text === text);
      if (!m) { if (role === 'user') userOk = false; else agentOk = false; return; }
      m.used = true;
      matched++;
      if (m.i > i) after = false;
      if (it.id !== undefined || m.id !== undefined) { idPairs++; if (it.id !== m.id) idsEqual = false; }
    });
    for (const x of resps) if (!x.used) { if (x.role === 'user') userNoItem = true; else assistantNoItem = true; }
  }
  return {
    itemCompletedMessages: items > 0,
    userItemsMirrored: user ? userOk : null,
    agentItemsMirrored: agent ? agentOk : null,
    itemAlwaysAfterResponse: matched ? after : null,
    itemIdEqualsResponseId: idPairs ? idsEqual : null,
    responseUserWithoutItem: items ? userNoItem : null,
    responseAssistantWithoutItem: items ? assistantNoItem : null,
  };
}

function codexFacts() {
  const rollouts = files(join(CODEX, 'sessions'), /rollout-.*\.jsonl$/);
  const perFile = rollouts.map(lines);
  const recs = perFile.flat();
  const tcOf = (rs: Rec[]) => rs.filter((r) => r.type === 'event_msg' && r.payload?.type === 'token_count');
  const tc = tcOf(recs);
  const info = tc.map((r) => r.payload?.info).filter(Boolean);
  const total = info.map((i) => i.total_token_usage).filter(Boolean);
  const rl = tc.map((r) => r.payload?.rate_limits).filter(Boolean);
  const metas = recs.filter((r) => r.type === 'session_meta');
  const resets = rl.flatMap((x) => [x.primary?.resets_at, x.secondary?.resets_at]).filter((v): v is number => typeof v === 'number');
  const tcx = recs.filter((r) => r.type === 'turn_context').map((r) => r.payload);
  const stateFiles = existsSync(CODEX) ? readdirSync(CODEX).filter((f) => /\.(sqlite|db)(-wal|-shm)?$/.test(f)).map((f) => f.replace(/\d+/g, '<n>')) : [];
  const cumulativeOk = perFile.every((rs) => { const t = tcOf(rs).map((r) => r.payload?.info?.total_token_usage?.total_tokens).filter((v): v is number => typeof v === 'number'); return t.every((v, i) => i === 0 || v >= t[i - 1]); });
  return {
    version: '0.160.0',
    rolloutPathPatterns: [...new Set(rollouts.map((f) => pattern(relative(CODEX, f))))].sort(),
    sessionIdInFilenameMatchesMeta: rollouts.length ? rollouts.every((f, i) => { const m = perFile[i].find((r) => r.type === 'session_meta'); return !!m && f.includes(String(m.payload?.id)); }) : null,
    recordTypes: vals(recs.map((r) => r.type)),
    payloadTypes: vals(recs.map((r) => r.payload?.type)),
    sources: vals(metas.map((r) => (typeof r.payload?.source === 'string' ? r.payload.source : r.payload?.source ? '<object>' : undefined))),
    originators: vals(metas.map((r) => r.payload?.originator)),
    sessionMetaKeys: keys(metas.map((r) => r.payload)),
    tokenCount: {
      present: tc.length > 0, infoKeys: keys(info), totalKeys: keys(total), lastKeys: keys(info.map((i) => i.last_token_usage)),
      modelContextWindow: info.some((i) => typeof i.model_context_window === 'number'),
      cachedSubsetOfInput: total.every((t) => (t.cached_input_tokens ?? 0) <= (t.input_tokens ?? 0)),
      reasoningSubsetOfOutput: total.every((t) => (t.reasoning_output_tokens ?? 0) <= (t.output_tokens ?? 0)),
      cumulativeNonDecreasingPerSession: cumulativeOk,
      rateLimitKeys: keys(rl), primaryKeys: keys(rl.map((x) => x.primary)), secondaryKeys: keys(rl.map((x) => x.secondary)),
      resetsAtUnit: resets.length ? (resets.every((v) => v > 1e12) ? 'ms' : resets.every((v) => v > 1e9) ? 'epoch-seconds' : 'relative-seconds') : null,
    },
    tokenUsageRecord: recs.some((r) => r.type === 'token_usage_record' || r.payload?.type === 'token_usage_record'),
    turnContextKeys: keys(tcx), turnContextModels: vals(tcx.map((t) => t?.model)), effortValues: vals(tcx.map((t) => t?.collaboration_mode?.settings?.reasoning_effort)), // FR-51 path; observed only as null on 0.160.0
    mirroredUserMessages: recs.some((r) => r.payload?.type === 'user_message') && recs.some((r) => r.type === 'response_item' && r.payload?.role === 'user'),
    messageMirroring: mirroring(perFile), // P2-T02: 0.160.0 mirrors through item_completed, not user_message
    compaction: { recorded: recs.some((r) => r.type === 'compacted'), keys: keys(recs.filter((r) => r.type === 'compacted').map((r) => r.payload)) },
    sessionIndex: existsSync(join(CODEX, 'session_index.jsonl')) ? { present: true, keys: keys(lines(join(CODEX, 'session_index.jsonl'))) } : { present: false },
    stateDbNames: [...new Set(stateFiles)].sort(),
    zstFiles: files(CODEX, /\.zst$/).length > 0,
    largePayloadFields: largeFields(recs),
  };
}

if (import.meta.main) {
  // --out <dir>: write facts.json and schemas there instead of over the committed evidence (re-extraction runs).
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1]! : undefined;
  const OUT_DIR = out ?? OUT;
  const SCHEMA_DIR = out ?? SCHEMAS;
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });
  const facts = { claude: claudeFacts(), codex: codexFacts() };
  writeFileSync(join(OUT_DIR, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
  const ENUMS = ['hook_event_name', 'type', 'subtype', 'role', 'model', 'version', 'stop_reason', 'entrypoint', 'userType', 'level', 'originator', 'source', 'service_tier', 'speed'];
  for (const [agent, root, re, ver] of [['claude', join(CLAUDE, 'projects'), /\.jsonl$/, '2.1.319'], ['codex', join(CODEX, 'sessions'), /rollout-.*\.jsonl$/, '0.160.0']] as const) {
    const red = reduce(files(root, re).flatMap(lines).map((r) => ({ event: String(r.type ?? 'unknown'), payload: r })), ENUMS);
    const schema = Object.fromEntries(Object.entries(red).map(([t, v]) => [t, Object.fromEntries(Object.entries(v.keys).map(([k, s]) => [k, s.values ? { types: s.types, values: s.values } : s.types]))]));
    writeFileSync(join(SCHEMA_DIR, `${agent}-${ver}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`);
  }
  console.log(JSON.stringify(facts, null, 1));
}
