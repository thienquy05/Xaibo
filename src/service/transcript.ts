// XAIBO-PROD-410 (P4-T05b1; design §5.2, §6.3): a stored record becomes a workspace transcript item or is skipped.
// Claude text and available reasoning come apart through claudeMessagePartsOf; tool records carry their stored text for
// on-demand slices. utf8Slice cuts bounded UTF-8 slices from a code-unit offset without splitting a code point.
import { isObj, type ItemKind } from '../shared/ipc.ts';
import { claudeMessagePartsOf } from './session-detail.ts';

export interface StoredRecord { agent: string; kind: string; role: string | null; injected: boolean; content: string | null; raw: string | null }
export interface Item { kind: ItemKind; text: string | null; reasoning: string | null }

type Obj = Record<string, unknown>;
const filled = (s: string | null): s is string => typeof s === 'string' && s !== '';
const item = (kind: ItemKind, text: string | null = null, reasoning: string | null = null): Item => ({ kind, text, reasoning });

function parsed(raw: string | null): Obj | undefined {
  if (raw === null) return undefined;
  try { const v: unknown = JSON.parse(raw); return isObj(v) ? v : undefined; } catch { return undefined; }
}

function claude(r: StoredRecord): Item | null {
  const rec = parsed(r.raw);
  if (!rec) return null;
  if (r.kind === 'system') return rec.subtype === 'compact_boundary' ? item('compaction') : null;
  if (r.kind !== 'message' || !isObj(rec.message)) return null;
  if (rec.isMeta === true) return null; // review 2: a meta record was never typed by the owner (S9 schema)
  const blocks = Array.isArray(rec.message.content) ? rec.message.content.filter(isObj) : [];
  const has = (type: string) => blocks.some((b) => b.type === type);
  const { text, reasoning } = claudeMessagePartsOf(rec.message); // one parse per record (review 1)
  if (rec.isCompactSummary === true) return item('compaction', text);
  const role = typeof rec.message.role === 'string' ? rec.message.role : r.role;
  if (role === 'user') {
    if (text !== null) return item('prompt', text);
    return has('tool_result') ? item('tool-result', filled(r.content) ? r.content : null) : null;
  }
  if (role !== 'assistant') return null;
  if (text !== null) return item('response', text, reasoning);
  if (has('tool_use')) return item('tool-call', filled(r.content) ? r.content : null);
  return reasoning !== null ? item('response', null, reasoning) : null;
}

function codex(r: StoredRecord): Item | null {
  switch (r.kind) {
    case 'message':
      if (!filled(r.content)) return null;
      return r.role === 'user' ? item('prompt', r.content) : r.role === 'assistant' ? item('response', r.content) : null;
    case 'tool_call': return item('tool-call', filled(r.content) ? r.content : null);
    case 'tool_result': return item('tool-result', filled(r.content) ? r.content : null);
    case 'compaction': return item('compaction', filled(r.content) ? r.content : null);
    case 'turn_aborted': return item('interrupted');
    default: return null;
  }
}

function agy(r: StoredRecord): Item | null {
  if (r.kind === 'tool_output') return item('tool-result', filled(r.content) ? r.content : null);
  if (!filled(r.content)) return null;
  return r.kind === 'user' ? item('prompt', r.content) : r.kind === 'assistant' ? item('response', r.content) : null;
}

const CLASSIFIERS = new Map<string, (r: StoredRecord) => Item | null>([['claude', claude], ['codex', codex], ['agy', agy]]);
/** The workspace item for a stored record, or null when it is not part of the conversation (bookkeeping, injected). */
export function classifyItem(r: StoredRecord): Item | null {
  if (r.injected) return null;
  return CLASSIFIERS.get(r.agent)?.(r) ?? null;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** At most maxBytes of UTF-8 from a code-unit offset; never splits a code point; always takes at least one when any
 *  remain. null for an offset outside the text or inside a surrogate pair. */
export function utf8Slice(text: string, offset: number, maxBytes: number): { text: string; next: number | null } | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return null;
  if (offset > 0 && offset < text.length && isLow(text.charCodeAt(offset)) && isHigh(text.charCodeAt(offset - 1))) return null;
  let i = offset, bytes = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    const pair = isHigh(c) && i + 1 < text.length && isLow(text.charCodeAt(i + 1));
    const size = pair ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3; // a lone surrogate encodes as U+FFFD (3 bytes)
    if (bytes + size > maxBytes && i > offset) break;
    bytes += size;
    i += pair ? 2 : 1;
  }
  return { text: text.slice(offset, i), next: i < text.length ? i : null };
}
