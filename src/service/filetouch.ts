// XAIBO-PROD-408 (P4-T05a, PRD FileTouch, OQ-P2-07): files a session touched, derived from stored tool-call evidence.
// Input is the raw args and result records of one call (events.raw). A write is confirmed only by a result for the
// same call id with `is_error: false`; an absent flag, an error or no result leaves it attempted.
// ponytail: only fixture-verified shapes (Claude Read/Write/Edit with file_path); add others (MultiEdit, Codex
// apply_patch, agy) when a fixture verifies their input and result shapes.

export type FileTouchKind = 'read' | 'write_attempted' | 'write_confirmed';
export interface ToolEvidence { agent: string; callId: string; argsRaw?: string; resultRaw?: string }
export interface FileTouch { path: string; kind: FileTouchKind; callId: string }

const MAX_PATH = 4096;
const READS = new Set(['Read']);
const WRITES = new Set(['Write', 'Edit']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The content blocks of a Claude record, or [] for anything unparsable. */
function blocks(raw: string | undefined): unknown[] {
  if (raw === undefined) return [];
  try {
    const r: unknown = JSON.parse(raw);
    const content = isObj(r) && isObj(r.message) ? r.message.content : undefined;
    return Array.isArray(content) ? content : [];
  } catch { return []; }
}

function claudeTouches(e: ToolEvidence): FileTouch[] {
  const use = blocks(e.argsRaw).find((b) => isObj(b) && b.type === 'tool_use' && b.id === e.callId) as Obj | undefined;
  if (!use || typeof use.name !== 'string' || !isObj(use.input)) return [];
  const path = use.input.file_path;
  if (typeof path !== 'string' || path === '' || path.length > MAX_PATH) return [];
  const res = blocks(e.resultRaw).find((b) => isObj(b) && b.type === 'tool_result' && b.tool_use_id === e.callId) as Obj | undefined;
  const failed = res?.is_error === true;
  const succeeded = res?.is_error === false;
  const touch = (kind: FileTouchKind): FileTouch => ({ path, kind, callId: e.callId });
  if (READS.has(use.name)) return failed ? [] : [touch('read')];
  if (WRITES.has(use.name)) return succeeded ? [touch('write_attempted'), touch('write_confirmed')] : [touch('write_attempted')];
  return [];
}

export function deriveFileTouches(calls: ToolEvidence[]): FileTouch[] {
  const seen = new Set<string>();
  const out: FileTouch[] = [];
  for (const e of calls) {
    if (e.agent !== 'claude') continue;
    for (const t of claudeTouches(e)) {
      const key = JSON.stringify([t.path, t.kind, t.callId]);
      if (!seen.has(key)) { seen.add(key); out.push(t); }
    }
  }
  return out;
}
