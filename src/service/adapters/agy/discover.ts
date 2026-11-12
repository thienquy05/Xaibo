// agy discovery (P2-T11, D-P2-02 (1), SEC5): <root>/brain/<uuid>/.system_generated/logs/transcript_full.jsonl only
// (transcript.jsonl may truncate, chunks/ duplicate it). A conversation must be a real directory (no symlink) and the
// transcript a regular file whose realpath stays inside the realpath root; anything else is never read.
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface AgyFile { path: string; kind: 'agy-transcript'; sessionId: string; compressed: false }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const transcriptOf = (home: string, id: string) => path.join(home, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');

/** Listed transcripts plus whether brain/ was readable (an unreadable brain/ proves nothing about deletions). */
export async function scan(root: string): Promise<{ home: string | null; brainReadable: boolean; files: AgyFile[] }> {
  let home: string;
  try { home = await realpath(root); } catch { return { home: null, brainReadable: false, files: [] }; }
  let dirs;
  try { dirs = await readdir(path.join(home, 'brain'), { withFileTypes: true }); } catch { return { home, brainReadable: false, files: [] }; }
  const files: AgyFile[] = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !UUID.test(d.name)) continue; // a symlinked conversation dir is not a directory entry here
    const file = transcriptOf(home, d.name);
    try {
      if (!(await lstat(file)).isFile() || path.relative(home, await realpath(file)).startsWith('..')) continue;
    } catch { continue; }
    files.push({ path: file, kind: 'agy-transcript', sessionId: d.name, compressed: false });
  }
  return { home, brainReadable: true, files };
}

export async function discover(root: string): Promise<AgyFile[]> { return (await scan(root)).files; }
