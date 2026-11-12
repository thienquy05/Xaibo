// Codex rollout discovery (P2-T03; S9 layout): <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl[.zst] and
// <CODEX_HOME>/archived_sessions/ (any depth). Realpath root (EC-18). State DBs and session_index.jsonl are never
// opened (S-03); only rollout files are listed.
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { filenameSessionId } from './parse.ts';

export interface CodexFile {
  path: string;
  kind: 'rollout';
  sessionId: string; // from the filename; the session_meta id wins when they differ (index.ts)
  archived: boolean;
  compressed: boolean;
}

async function rollouts(dir: string, archived: boolean): Promise<CodexFile[]> {
  let entries;
  try { entries = await readdir(dir, { recursive: true, withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    const id = e.isFile() ? filenameSessionId(e.name) : undefined;
    return id ? [{ path: path.join(e.parentPath, e.name), kind: 'rollout' as const, sessionId: id, archived, compressed: e.name.endsWith('.zst') }] : [];
  });
}

export async function discover(root: string): Promise<CodexFile[]> {
  let home: string;
  try { home = await realpath(root); } catch { return []; }
  return [...await rollouts(path.join(home, 'sessions'), false), ...await rollouts(path.join(home, 'archived_sessions'), true)];
}
