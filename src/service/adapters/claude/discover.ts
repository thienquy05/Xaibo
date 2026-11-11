// Claude transcript discovery (P1-T10; S9 layout): <root>/projects/<encoded-cwd>/<uuid>.jsonl[.zst] and
// <root>/projects/<encoded-cwd>/<uuid>/subagents/agent-<id>.jsonl[.zst]. Paths are realpaths so symlinked
// homes and project dirs group under one path (EC-18). Directory names are never parsed for a cwd (EC-16).
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface ClaudeFile {
  path: string;
  kind: 'transcript' | 'subagent';
  sessionId: string; // file's session: the transcript's uuid, or the parent session of a subagent file
  subagentId?: string;
  compressed: boolean;
}

const TRANSCRIPT = /^([0-9a-fA-F-]{36})\.jsonl(\.zst)?$/;
const SESSION_DIR = /^[0-9a-fA-F-]{36}$/;
const SUBAGENT = /^agent-(.+?)\.jsonl(\.zst)?$/;

async function entries(dir: string) {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
}

export async function discover(root: string): Promise<ClaudeFile[]> {
  let projects: string;
  try { projects = path.join(await realpath(root), 'projects'); } catch { return []; }
  const out: ClaudeFile[] = [];
  for (const d of await entries(projects)) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    let dir: string;
    try { dir = await realpath(path.join(projects, d.name)); } catch { continue; }
    for (const f of await entries(dir)) {
      const t = TRANSCRIPT.exec(f.name);
      if (t && !f.isDirectory()) out.push({ path: path.join(dir, f.name), kind: 'transcript', sessionId: t[1]!, compressed: !!t[2] });
      else if (SESSION_DIR.test(f.name) && f.isDirectory()) {
        const sub = path.join(dir, f.name, 'subagents');
        for (const s of await entries(sub)) {
          const m = SUBAGENT.exec(s.name);
          if (m && !s.isDirectory()) out.push({ path: path.join(sub, s.name), kind: 'subagent', sessionId: f.name, subagentId: m[1]!, compressed: !!m[2] });
        }
      }
    }
  }
  return out;
}
