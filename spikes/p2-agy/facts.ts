// P2-T00 agy fact extraction over the TEMP profile only (plus the run's raw stream/hook captures in .cache).
// Emits booleans, key sets, allowlisted values and masked file patterns; never content, IDs, paths or numbers.
// Usage: node spikes/p2-agy/facts.ts [--out <dir>]   (default: spikes/p2-agy/evidence and spikes/p2-agy/schemas)
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { reduce } from '../shared/reduce.ts';

const PROFILE = join(homedir(), '.xaibo-spike-profiles', 'agy-a');
const ROOT = join(PROFILE, 'home', '.gemini', 'antigravity-cli');
const CONFIG = join(PROFILE, 'home', '.gemini', 'config');
const RAW = join(import.meta.dirname, '..', '..', '.cache', 'spike-results', 'p2-agy', 'raw');
const IDENT = /^[A-Za-z_][A-Za-z0-9_.-]{0,40}$/;
const ENUMS = ['type', 'source', 'status', 'event', 'state', 'step_type', 'tool_name', 'name', 'hookEventName', 'terminationReason', 'modelName', 'permission_mode'];

type Rec = Record<string, any>;
interface Usage { input_tokens: number; output_tokens: number; thinking_tokens: number; cache_read_tokens: number; total_tokens: number }

const files = (root: string, re: RegExp) => (existsSync(root) ? readdirSync(root, { recursive: true }).map(String).filter((f) => re.test(f)).map((f) => join(root, f)) : []);
const lines = (f: string): Rec[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Rec]; } catch { return []; } }) : []);
const vals = (xs: unknown[]) => [...new Set(xs.filter((x): x is string => typeof x === 'string').map((x) => (IDENT.test(x) ? x : '<other>')))].sort();
const keyPaths = (o: unknown, p = ''): string[] => (o && typeof o === 'object' && !Array.isArray(o)
  ? Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}${Array.isArray(v) ? '[]' : ''}`])) : []);
const pattern = (rel: string) => rel
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
  .replace(/\d{8}_\d{6}/g, '<ts>')
  .replace(/\/\d{8}\.jsonl$/, '/<n>.jsonl');
const same = (a: Usage, b: Usage) => (['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'] as const).every((k) => a[k] === b[k]);

/** Token relationships over the runs of one conversation, in order (per-step usages and each run's result usage). */
export function usageRelations(runs: { steps: Usage[]; result?: Usage }[]) {
  const all = runs.flatMap((r) => [...r.steps, ...(r.result ? [r.result] : [])]);
  if (all.length === 0) {
    return { observed: false, totalEqualsInputOutputThinking: null, totalEqualsInputOutput: null, cacheReadWithinInput: null, thinkingWithinOutput: null, resultCumulativeOverConversation: null };
  }
  const zero: Usage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };
  const add = (a: Usage, b: Usage): Usage => ({
    input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens, thinking_tokens: a.thinking_tokens + b.thinking_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens, total_tokens: a.total_tokens + b.total_tokens,
  });
  let soFar = zero;
  const cumulative = runs.map((r) => { soFar = r.steps.reduce(add, soFar); return !r.result || same(soFar, r.result); });
  return {
    observed: true,
    totalEqualsInputOutputThinking: all.every((u) => u.total_tokens === u.input_tokens + u.output_tokens + u.thinking_tokens),
    totalEqualsInputOutput: all.every((u) => u.total_tokens === u.input_tokens + u.output_tokens),
    cacheReadWithinInput: all.every((u) => u.cache_read_tokens <= u.input_tokens),
    thinkingWithinOutput: all.every((u) => u.thinking_tokens <= u.output_tokens), // necessary, not sufficient, for inclusion
    resultCumulativeOverConversation: runs.some((r) => r.result) ? cumulative.every(Boolean) : null,
  };
}

/** history.jsonl key names and relations (D-P2-02 (1)): a conversation-id key is present somewhere and every present
 *  value is a known folder id; an absolute-path key holds only strings starting with '/'. Key names and booleans only. */
export function historyRelations(entries: Rec[], convIds: string[], project: string) {
  if (entries.length === 0) {
    return { observed: false, keys: [] as string[], conversationIdKeys: [] as string[], absolutePathKeys: [] as string[], everyEntryHasConversationId: null, sameConversationSameWorkspace: null, pathEqualsEvaluationProject: null };
  }
  const keys = [...new Set(entries.flatMap((e) => Object.keys(e)))].sort();
  const ids = new Set(convIds);
  const only = (k: string, ok: (v: unknown) => boolean) => entries.some((e) => k in e) && entries.every((e) => !(k in e) || ok(e[k]));
  const conversationIdKeys = keys.filter((k) => only(k, (v) => typeof v === 'string' && ids.has(v)));
  const absolutePathKeys = keys.filter((k) => only(k, (v) => typeof v === 'string' && v.startsWith('/')));
  const [c, w] = [conversationIdKeys[0], absolutePathKeys[0]];
  const linked = c ? entries.filter((e) => c in e) : [];
  return {
    observed: true, keys, conversationIdKeys, absolutePathKeys,
    everyEntryHasConversationId: c ? linked.length === entries.length : false,
    sameConversationSameWorkspace: c && w ? linked.every((e) => linked.every((x) => x[c] !== e[c] || x[w] === e[w])) : null,
    pathEqualsEvaluationProject: entries.some((e) => absolutePathKeys.some((k) => e[k] === project)),
  };
}

function streamRuns() {
  return files(RAW, /^p\d+\.ndjson$/).sort().map((f) => {
    const recs = lines(f);
    return {
      recs,
      steps: recs.filter((r) => r.event === 'step_update' && r.step_update?.state === 'DONE' && r.step_update?.usage).map((r) => r.step_update.usage as Usage),
      result: recs.find((r) => r.event === 'result')?.result?.usage as Usage | undefined,
    };
  });
}

function agyFacts() {
  const all = files(ROOT, /./).filter((f) => !/\/(builtin|cache\/marketplaces)\//.test(f));
  const convDirs = existsSync(join(ROOT, 'brain')) ? readdirSync(join(ROOT, 'brain')) : [];
  const logs = (id: string) => join(ROOT, 'brain', id, '.system_generated', 'logs');
  const transcript = convDirs.flatMap((id) => lines(join(logs(id), 'transcript.jsonl')));
  const full = convDirs.flatMap((id) => lines(join(logs(id), 'transcript_full.jsonl')));
  const chunksEqual = convDirs.every((id) => ['transcript', 'transcript_full'].every((n) => {
    const main = join(logs(id), `${n}.jsonl`);
    const parts = files(join(logs(id), 'chunks', n), /\.jsonl$/).sort();
    return !existsSync(main) || parts.map((p) => readFileSync(p, 'utf8')).join('') === readFileSync(main, 'utf8');
  }));
  const runs = streamRuns();
  const convIds = new Set(runs.flatMap((r) => r.recs.map((x) => x.conversation_id ?? x.step_update?.conversation_id ?? x.result?.conversation_id)).filter(Boolean));
  const hooks = lines(join(RAW, 'agy.jsonl'));
  const hookLabels = vals(hooks.map((h) => h.event));
  const everyKey = [...transcript, ...full, ...runs.flatMap((r) => r.recs)].flatMap((r) => keyPaths(r));
  const versions = existsSync(join(PROFILE, 'versions.log')) ? readFileSync(join(PROFILE, 'versions.log'), 'utf8').trim().split('\n').map((l) => l.split('\t')[1]) : [];
  return {
    version: versions.at(-1) ?? null,
    versionStableAcrossRuns: versions.length ? new Set(versions).size === 1 : null,
    dataRoot: '~/.gemini/antigravity-cli',
    filePatterns: [...new Set(all.map((f) => pattern(relative(ROOT, f))))].sort(),
    configFiles: [...new Set(files(CONFIG, /./).map((f) => pattern(relative(CONFIG, f))))].sort(),
    credentialFileMode0600: existsSync(join(ROOT, 'antigravity-oauth-token')) ? (statSync(join(ROOT, 'antigravity-oauth-token')).mode & 0o777) === 0o600 : null,
    transcript: {
      recordTypes: vals(transcript.map((r) => r.type)),
      sources: vals(transcript.map((r) => r.source)),
      statuses: vals(transcript.map((r) => r.status)),
      fullHasSameRecordCount: transcript.length === full.length,
      chunksConcatenateToMain: chunksEqual,
      truncatedFieldsSeen: transcript.some((r) => 'truncated_fields' in r),
      conversationIdPerRecord: transcript.some((r) => 'conversation_id' in r || 'conversationId' in r),
      modelFieldPerRecord: transcript.some((r) => keyPaths(r).some((k) => /model/i.test(k))),
      thinkingTokensInTranscript: transcript.some((r) => 'thinking_tokens' in r),
      toolCallKeys: [...new Set(transcript.flatMap((r) => (Array.isArray(r.tool_calls) ? r.tool_calls.flatMap((t: Rec) => keyPaths(t)) : [])))].sort(),
      stepIndexStrictlyIncreasing: convDirs.every((id) => lines(join(logs(id), 'transcript.jsonl')).every((r, i, a) => i === 0 || r.step_index > a[i - 1].step_index)),
      // PLANNER_RESPONSE usage equals the stream's per-step usage, in order (only meaningful with one evaluated conversation).
      plannerUsageMatchesStreamSteps: ((tr, st) => (st.length ? tr.length === st.length && tr.every((r, i) => r.input_tokens === st[i]!.input_tokens
        && r.output_tokens === st[i]!.output_tokens && r.cache_read_tokens === st[i]!.cache_read_tokens) : null))(
        [...convIds].flatMap((id) => lines(join(logs(String(id)), 'transcript.jsonl'))).filter((r) => r.type === 'PLANNER_RESPONSE'), runs.flatMap((r) => r.steps)),
    },
    stream: {
      events: vals(runs.flatMap((r) => r.recs.map((x) => x.event))),
      stepTypes: vals(runs.flatMap((r) => r.recs.map((x) => x.step_update?.step_type))),
      states: vals(runs.flatMap((r) => r.recs.map((x) => x.step_update?.state))),
      resultStatuses: vals(runs.flatMap((r) => r.recs.map((x) => x.result?.status))),
      toolNames: vals(runs.flatMap((r) => r.recs.map((x) => x.step_update?.tool_name))),
      resumeKeepsConversation: runs.length > 1 ? convIds.size === 1 : null,
      usage: usageRelations(runs),
    },
    history: historyRelations(lines(join(ROOT, 'history.jsonl')), convDirs, ((p) => (existsSync(p) ? realpathSync(p) : p))(join(import.meta.dirname, '..', '..', '.cache', 'spike-projects', 'p2-agy'))),
    effortKeyAnywhere: everyKey.some((k) => /effort/i.test(k)),
    hooks: {
      labelsFired: hookLabels,
      projectFileLoaded: hookLabels.some((l) => l.endsWith('-project')),
      globalConfigFileLoaded: hookLabels.some((l) => l.endsWith('-global')),
      emptyOutputAccepted: runs.length > 0 && runs.every((r) => r.recs.some((x) => x.event === 'result' && x.result?.status === 'SUCCESS')),
      toolCallIdInToolEvents: hooks.filter((h) => /ToolUse/.test(h.event)).every((h) => typeof h.payload?.toolCall?.id === 'string') || null,
      modelNames: vals(hooks.map((h) => h.payload?.modelName)),
      terminationReasons: vals(hooks.map((h) => h.payload?.terminationReason)),
    },
  };
}

if (import.meta.main) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1]! : undefined;
  const ev = out ?? join(import.meta.dirname, 'evidence');
  const sc = out ?? join(import.meta.dirname, 'schemas');
  mkdirSync(ev, { recursive: true });
  mkdirSync(sc, { recursive: true });
  const facts = agyFacts();
  writeFileSync(join(ev, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
  const schema = (recs: { event: string; payload: unknown }[]) => Object.fromEntries(Object.entries(reduce(recs, ENUMS))
    .map(([t, v]) => [t, Object.fromEntries(Object.entries(v.keys).map(([k, s]) => [k, s.values ? { types: s.types, values: s.values } : s.types]))]));
  const ver = facts.version ?? 'unknown';
  const convDirs = existsSync(join(ROOT, 'brain')) ? readdirSync(join(ROOT, 'brain')) : [];
  const tr = convDirs.flatMap((id) => lines(join(ROOT, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl')));
  writeFileSync(join(sc, `agy-${ver}.transcript.schema.json`), `${JSON.stringify(schema(tr.map((r) => ({ event: String(r.type ?? 'unknown'), payload: r }))), null, 2)}\n`);
  writeFileSync(join(sc, `agy-${ver}.stream.schema.json`), `${JSON.stringify(schema(streamRuns().flatMap((r) => r.recs).map((r) => ({ event: String(r.event ?? 'unknown'), payload: r }))), null, 2)}\n`);
  writeFileSync(join(sc, `agy-${ver}.hooks.schema.json`), `${JSON.stringify(schema(lines(join(RAW, 'agy.jsonl')).map((h) => ({ event: String(h.event).replace(/-(project|global)$/, ''), payload: h.payload }))), null, 2)}\n`);
  console.log(JSON.stringify(facts, null, 1));
}
