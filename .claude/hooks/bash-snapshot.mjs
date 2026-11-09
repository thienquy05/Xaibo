#!/usr/bin/env node
// Before/after view of one Bash call (§2.1 component 4), so the post-Bash backstop judges only what
// *that call* changed and never touches edits that were already in the working tree.
//   save <project> <tool_use_id>            run by enforce-gate.sh before every Bash call
//   compare <project> <tool_use_id>         run by post-bash-revert.sh after it; prints `CONFIG <path>` for a
//                                           tracked config file the call changed and `GATED <path>` for a
//                                           gated file it changed (unless a checkout brought it, below);
//                                           a config file whose content is unchanged but whose mode
//                                           changed gets its mode put back and a `MODE <path>` line
//   restore <project> <tool_use_id> <path>  keeps the current content in quarantine, puts back the content
//                                           from before the call, and prints where the kept copy is
//   done <project> <tool_use_id>            removes the call's state
// The state lives in the repo's git dir, one file per tool_use_id, so parallel Bash calls don't collide.
// Content is kept as raw git blobs (`hash-object -w --no-filters`): no line-ending or clean filter, so a
// change of bytes is always seen and a config file is put back byte for byte (Codex, round 5).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  closeSync,
  fchmodSync,
  openSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

const CONFIG_FILES = ['.claude/harness.config.json', '.claude/hooks/enforce-gate.sh', '.claude/settings.json'];
const STALE_MS = 24 * 60 * 60 * 1000; // a blocked call never reaches its post hook; its state goes after a day

const [mode, project, id = 'none', target] = process.argv.slice(2);
const git = (args, input) => execFileSync('git', args, { cwd: project, input, stdio: ['pipe', 'pipe', 'ignore'] });

const head = () => {
  try {
    return git(['rev-parse', 'HEAD']).toString().trim();
  } catch {
    return '';
  }
};

// Every branch and tag tip before the call: a commit reachable from them existed before it.
const tips = () => {
  try {
    return git(['for-each-ref', '--format=%(objectname)']).toString().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

// The blob id of path in commit rev, or null.
const blobAt = (rev, path) => {
  try {
    return git(['rev-parse', `${rev}:${path}`]).toString().trim();
  } catch {
    return null;
  }
};

// What git would store for the working-tree file (filters applied), to compare with a commit's blob.
const storedAs = (path) => git(['hash-object', '--', path]).toString().trim();

let gitDir;
try {
  gitDir = git(['rev-parse', '--absolute-git-dir']).toString().trim();
} catch {
  process.exit(0); // not a git repo: post-bash-revert.sh warns about that itself
}
const stateDir = join(gitDir, 'harness-bash');
const stateFile = join(stateDir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

function gatedGlobs() {
  try {
    const config = JSON.parse(readFileSync(join(project, '.claude', 'harness.config.json'), 'utf8'));
    return Array.isArray(config.gatedGlobs) ? config.gatedGlobs : [];
  } catch {
    return [];
  }
}

const listGated = (globs) =>
  globs.length ? globSync(globs, { cwd: project, exclude: (p) => /(^|\/)(node_modules|\.git)$/.test(p) }) : [];

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

const rawBlob = (path) => git(['hash-object', '-w', '--no-filters', '--', path]).toString().trim();

// path -> blob id of a regular file; for a symlink, `link:<target>:<blob of what it points to>`, so a
// changed link and a write through it both show (Codex, rounds 6-7); null when nothing is there.
function hashes(paths) {
  const result = Object.fromEntries(paths.map((p) => [p, null]));
  const regular = [];
  for (const p of paths) {
    const full = join(project, p);
    const st = lstatOrNull(full);
    if (st?.isSymbolicLink()) {
      const target = statSync(full, { throwIfNoEntry: false });
      result[p] = `link:${readlinkSync(full)}:${target?.isFile() ? rawBlob(full) : ''}`;
    } else if (st?.isFile()) regular.push(p);
  }
  const ids = regular.length ? git(['hash-object', '-w', '--no-filters', '--stdin-paths'], regular.join('\n')).toString().trim().split('\n') : [];
  regular.forEach((p, i) => (result[p] = ids[i]));
  return result;
}

// Puts content at path as a brand-new file (temp sibling, then rename), so neither a symlink nor a hard
// link at path is written through (Codex, rounds 6 and 10), and applies the saved mode, if any.
// The temporary name is random and opened with 'wx' (create only, never an existing path or link), and
// it is written and chmodded through that descriptor, so nothing planted there is touched (round 11).
function replaceWithFreshFile(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.harness-restore-${randomUUID()}`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, content);
    if (mode != null) fchmodSync(fd, mode & 0o7777);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(tmp, path);
}

// Is the nearest existing folder of path inside the project, with no symlink leading out of it?
function insideProject(path) {
  let dir = dirname(path);
  while (!existsSync(dir)) dir = dirname(dir);
  return `${realpathSync(dir)}${sep}`.startsWith(`${realpathSync(project)}${sep}`);
}

if (mode === 'save') {
  // The tracked config must be regular files: a symlink could hide writes to its target and has no
  // safe restore (Codex, round 7). harness init writes regular files, so only tampering gets here.
  const linked = CONFIG_FILES.filter((p) => lstatOrNull(join(project, p))?.isSymbolicLink());
  if (linked.length) {
    process.stderr.write(`[enforce-gate] ${linked.join(', ')} is a symlink; Bash is refused until it is a regular file again (CONST-CORE-004).\n`);
    process.exit(3);
  }
  mkdirSync(stateDir, { recursive: true });
  for (const name of readdirSync(stateDir).filter((n) => n.endsWith('.json'))) {
    const file = join(stateDir, name);
    if (Date.now() - statSync(file).mtimeMs > STALE_MS) rmSync(file, { force: true });
  }
  const globs = gatedGlobs();
  const modes = Object.fromEntries(CONFIG_FILES.map((p) => [p, lstatOrNull(join(project, p))?.mode ?? null]));
  writeFileSync(stateFile, JSON.stringify({ head: head(), tips: tips(), globs, modes, files: hashes([...new Set([...CONFIG_FILES, ...listGated(globs)])]) }));
} else if (mode === 'compare') {
  if (!existsSync(stateFile)) process.exit(0);
  const before = JSON.parse(readFileSync(stateFile, 'utf8'));
  // Config changes are always judged (by integrity, in post-bash-revert.sh): a command can tamper and
  // then commit (Codex, rounds 2-3). A gated change is judged too, unless HEAD moved to a commit that
  // was reachable from a branch or tag before the call (a checkout of existing work) *and* the file
  // now matches that commit exactly (Codex, round 4: per file, never by timestamp). Commits made
  // during the call, including backdated ones and those a pull fetched, are not exempt.
  const now = head();
  const existed =
    now !== before.head && now !== '' && before.tips.length > 0 &&
    git(['rev-list', '--max-count=1', now, '--not', ...before.tips]).toString().trim() === '';
  const current = hashes([...new Set([...Object.keys(before.files), ...listGated(before.globs)])]);
  const lines = [];
  for (const [path, blob] of Object.entries(current)) {
    if (blob === (before.files[path] ?? null)) {
      // Same bytes, other mode: `chmod -x` on the hook disables the gate without touching its content
      // or its checksum (Codex, round 8). Putting the mode back loses nothing, so it is unconditional.
      const was = before.modes?.[path];
      const st = CONFIG_FILES.includes(path) ? lstatOrNull(join(project, path)) : null;
      // A second hard link also counts: it shares this file with a path outside our control.
      if (st?.isFile() && was != null && ((st.mode & 0o7777) !== (was & 0o7777) || st.nlink > 1)) {
        // Never chmod through a folder that now leads outside the project (Codex, round 9).
        if (!insideProject(join(project, path))) {
          lines.push(`OUTSIDE ${path}`);
          continue;
        }
        replaceWithFreshFile(join(project, path), git(['cat-file', 'blob', blob]), was);
        lines.push(`MODE ${path}`);
      }
      continue;
    }
    if (CONFIG_FILES.includes(path)) lines.push(`CONFIG ${path}`);
    else if (!(existed && blob !== null && storedAs(path) === blobAt(now, path))) lines.push(`GATED ${path}`);
  }
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
} else if (mode === 'restore') {
  // Prints `RESTORED <where the found content is kept>` or `SKIPPED <reason>`.
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const was = state.files[target] ?? null;
  const file = join(project, target);
  if (!insideProject(file)) {
    process.stdout.write('SKIPPED its folder is a symlink to outside the project\n');
    process.exit(0);
  }
  // What is there now may be someone else's concurrent edit (Codex, round 2), so it is kept first;
  // a symlink is kept as its link text, never followed.
  const found = lstatOrNull(file);
  let kept = 'nothing (the file was gone)';
  if (found) {
    const quarantine = join(stateDir, 'quarantine');
    mkdirSync(quarantine, { recursive: true });
    kept = join(quarantine, `${target.replace(/\//g, '__')}.${Date.now()}`);
    writeFileSync(kept, found.isSymbolicLink() ? `symlink -> ${readlinkSync(file)}\n` : readFileSync(file));
  }
  // `was` is never a symlink here: save refuses while a config file is one.
  if (was === null) {
    rmSync(file, { force: true });
  } else {
    replaceWithFreshFile(file, git(['cat-file', 'blob', was]), state.modes?.[target]);
  }
  process.stdout.write(`RESTORED ${kept}\n`);
} else if (mode === 'done') {
  rmSync(stateFile, { force: true });
}
