// The checkouts of a governed project, shared by parse-tool-call.mjs and bash-snapshot.mjs. Claude Code
// keeps worktrees at <main>/.claude/worktrees/<name>/ (checked 2026-11-18, Claude Code 2.1.327), and only
// that location counts: a .git file elsewhere, which any command can write, never makes a folder of the
// main checkout (say src/) a checkout of its own. packages/core project-path.ts applies the same rule.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// git's common dir for a checkout: its .git folder, or for a linked worktree's .git file the admin dir's
// `commondir`. Throws for anything else (a submodule or --separate-git-dir checkout has no commondir).
function commonGitDir(root) {
  const dotGit = join(root, '.git');
  if (statSync(dotGit).isDirectory()) return dotGit;
  const adminDir = resolve(root, /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))[1].trim());
  return resolve(adminDir, readFileSync(join(adminDir, 'commondir'), 'utf8').trim());
}

// The main checkout of hookRoot's repository: hookRoot itself unless it is a linked worktree of a
// repository whose git dir is a real <main>/.git (the rule packages/core mainCheckoutOf applies).
function mainCheckout(hookRoot) {
  let common;
  try {
    common = commonGitDir(hookRoot);
  } catch {
    return hookRoot;
  }
  const main = dirname(common);
  return basename(common) !== '.git' || realOrSelf(main) === realOrSelf(hookRoot) ? hookRoot : main;
}

const worktreesDir = (main) => join(main, '.claude', 'worktrees');

/** The checkout of this project whose root is dir (the main one, or a worktree in Claude Code's location sharing its .git), or null. */
export function checkoutAt(dir, hookRoot) {
  if (realOrSelf(dir) === realOrSelf(hookRoot)) return hookRoot;
  try {
    const main = mainCheckout(hookRoot);
    if (realOrSelf(dir) === realOrSelf(main)) return main;
    const inWorktreesDir = realOrSelf(dirname(dir)) === realOrSelf(worktreesDir(main));
    return inWorktreesDir && realOrSelf(commonGitDir(dir)) === realOrSelf(join(main, '.git')) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * What a Bash call can touch in this project: the hooks' own checkout (always), its main checkout and every
 * folder in the worktrees location. shortcut: a call snapshots every worktree, so with parallel worktree
 * subagents one call's Post can flag another's legitimate edit made meanwhile (an alarm, never a miss);
 * narrow it to files that matched HEAD at Pre if that turns out noisy.
 */
export function checkouts(hookRoot) {
  const main = mainCheckout(hookRoot);
  const dir = worktreesDir(main);
  let worktrees = [];
  try {
    worktrees = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
  } catch {
    // no worktrees location
  }
  return [...new Set([hookRoot, main, ...worktrees])];
}
