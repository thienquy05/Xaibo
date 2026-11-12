#!/usr/bin/env node
// Shared by enforce-gate.sh (PreToolUse) and post-bash-revert.sh (PostToolUse)
// so the JSON-payload parsing and the Bash-write heuristic exist in exactly
// one place, not copy-pasted into two shell scripts. Reads the hook JSON
// payload from stdin, prints `KEY=value` lines the calling shell script
// `eval`s directly.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  const payload = JSON.parse(raw || '{}');
  const toolName = payload.tool_name || '';
  const projectPath = payload.cwd || process.cwd();
  const input = payload.tool_input || {};
  const command = typeof input.command === 'string' ? input.command : '';

  const filePath = typeof input.file_path === 'string' ? input.file_path : extractBashWriteTarget(command);
  const matchedTestCommand = toolName === 'Bash' ? matchConfiguredTestCommand(projectPath, command) : '';

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
