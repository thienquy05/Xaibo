#!/usr/bin/env node
// Shared by enforce-gate.sh (PreToolUse) and post-bash-revert.sh (PostToolUse)
// so the JSON-payload parsing and the Bash-write heuristic exist in exactly
// one place, not copy-pasted into two shell scripts. Reads the hook JSON
// payload from stdin, prints `KEY=value` lines the calling shell script
// `eval`s directly.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkoutAt } from './checkouts.mjs';

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  const payload = JSON.parse(raw || '{}');
  const toolName = payload.tool_name || '';
  // The hooks' own project is the folder holding this script's .claude/hooks/, never payload.cwd: Claude Code
  // keeps a `cd` between Bash calls, so the shell can sit in any subfolder. argv[1] is the path the calling
  // hook passed ("$SCRIPT_DIR/parse-tool-call.mjs"), not symlink-resolved, so it matches the project path
  // gate-check maps to its /workspaces mount.
  const hookRoot = dirname(dirname(dirname(process.argv[1])));
  const input = payload.tool_input || {};
  const command = typeof input.command === 'string' ? input.command : '';

  // The shell's folder still matters for what the command itself names: a relative redirect target, and
  // whether a test command means a checkout's suite. Typed at the root of a checkout (this one, its main
  // checkout or a Claude Code worktree) it is run there and recorded for that checkout, so a worktree's RED
  // is its own; from any other folder (perhaps another package's) it runs unrecorded, never opening the gate.
  const shellDir = resolve(payload.cwd || hookRoot);
  const target = extractBashWriteTarget(command);
  const filePath = typeof input.file_path === 'string' ? input.file_path : target && resolve(shellDir, target);
  const testRoot = toolName === 'Bash' && payload.hook_event_name === 'PreToolUse' ? checkoutAt(shellDir, hookRoot) : null;
  const matchedTestCommand = testRoot ? matchConfiguredTestCommand(testRoot, command) : '';
  // Every other check speaks for the hooks' own checkout; gate-check decides which checkout governs a
  // file it is given (packages/core gates.ts), so a write across checkouts is judged where it lands.
  const projectPath = matchedTestCommand ? testRoot : hookRoot;

  const lines = [
    `HARNESS_TOOL_NAME=${shellEscape(toolName)}`,
    `HARNESS_PROJECT_PATH=${shellEscape(projectPath)}`,
    `HARNESS_FILE_PATH=${shellEscape(filePath)}`,
    `HARNESS_BASH_COMMAND=${shellEscape(command)}`,
    `HARNESS_MATCHED_TEST_COMMAND=${shellEscape(matchedTestCommand)}`,
    // Pairs a Bash call's PreToolUse snapshot with its PostToolUse(Failure) check (bash-snapshot.mjs).
    `HARNESS_TOOL_USE_ID=${shellEscape(payload.tool_use_id || 'none')}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
});

/**
 * Returns the full command Claude is about to run (not just the matched
 * prefix) if it is, or starts with, one of harness.config.json's configured
 * testCommands — the signal enforce-gate.sh uses to decide whether to run
 * this command itself, host-side, and record the real exit code (§12.3).
 * Reads harness.config.json fresh off disk rather than trusting anything in
 * the hook payload, since CONST-CORE-004 tracks that file's checksum.
 */
function matchConfiguredTestCommand(projectPath, command) {
  if (!command) return '';
  try {
    const raw = readFileSync(join(projectPath, '.claude', 'harness.config.json'), 'utf-8');
    const config = JSON.parse(raw);
    const testCommands = Array.isArray(config.testCommands) ? config.testCommands : [];
    const trimmed = command.trim();
    const entry = testCommands.find(
      (e) => typeof e.command === 'string' && (trimmed === e.command || trimmed.startsWith(`${e.command} `)),
    );
    if (!entry) return '';
    // Only what harness-os can trust is run and recorded. Anything after the first pipe, list, redirect,
    // substitution or quote is dropped (`npm test | tail` hid failures, `npm test | grep -q x` faked a
    // RED). Of the arguments before it, only `--` and existing paths are kept: a missing path or an
    // unknown flag makes a passing suite exit non-zero (a fake RED), and flags such as -u or
    // --outputFile write files outside the gate. Otherwise the configured command runs alone.
    const head = trimmed.slice(entry.command.length).split(/(?:\s\d+)?[|&;<>()$`'"\\\n]/)[0]; // `2>&1`: the fd belongs to the redirect
    const args = head.split(/\s+/).filter(Boolean);
    const plain = args.every((a) => a === '--' || (!a.startsWith('-') && existsSync(join(projectPath, a))));
    return plain && args.length > 0 ? `${entry.command} ${args.join(' ')}` : entry.command;
  } catch {
    return '';
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Conservative on purpose (Open Item #8): recognizes simple redirects (`>`,
 * `>>`), `sed -i ... FILE`, and `tee FILE`. Anything this misses is not a
 * silent bypass — post-bash-revert.sh's git-diff backstop (§2.1 component 4)
 * catches whatever this heuristic doesn't.
 */
function extractBashWriteTarget(command) {
  if (!command) return '';

  const redirect = command.match(/(?:^|\s)>{1,2}\s*([^\s|;&]+)/);
  if (redirect) return redirect[1];

  const sed = command.match(/\bsed\b[^|;&]*-i\S*\s+(?:-e\s+\S+\s+)?['"]?[^'"]*['"]?\s+([^\s|;&'"]+)/);
  if (sed) return sed[1];

  const tee = command.match(/\btee\b\s+(?:-a\s+)?([^\s|;&]+)/);
  if (tee) return tee[1];

  return '';
}
