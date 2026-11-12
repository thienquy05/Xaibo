#!/bin/bash
# PreToolUse hook: Edit|Write|Bash (see settings.json's matcher). Implements
# §2.1 component 1. Fails closed on any internal error in this script — an
# error here must block the write, not silently allow it.
#
# Claude Code only *blocks* a tool call on exit code 2; any other non-zero
# exit is a non-blocking hook error (shown as a warning, write proceeds). So
# "fail closed" requires an explicit trap that forces exit 2 — without it, a
# crash in this script (or in parse-tool-call.mjs) fails OPEN by accident,
# because `set -u` on an unset var, or the exit status of a command
# substitution feeding `eval`, does not itself surface as exit 2.
set -euo pipefail
trap 'echo "{\"action\":\"internal_error\",\"reason\":\"enforce-gate.sh failed unexpectedly - failing closed (CONST-CORE-004)\"}" >&2; exit 2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$(cat)"
eval "$(printf '%s' "$PAYLOAD" | node "$SCRIPT_DIR/parse-tool-call.mjs")"

if [[ -z "${HARNESS_TOOL_NAME:-}" ]]; then
  echo '{"action":"internal_error","reason":"enforce-gate.sh: parse-tool-call.mjs produced no output - failing closed (CONST-CORE-004)"}' >&2
  exit 2
fi

if [[ "$HARNESS_TOOL_NAME" != "Edit" && "$HARNESS_TOOL_NAME" != "Write" && "$HARNESS_TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

# TDD RED-phase gate, execution half (§12.3 / Option 1): when the Bash
# command Claude is about to run matches this project's checksummed
# harness.config.json testCommands, enforce-gate.sh — not Claude, not
# gate-check.js inside harness_gate_daemon (which has no toolchain and only a
# read-only mount, see project-path.ts) — runs that exact command itself,
# host-side, real cwd, real toolchain, and records the real exit code it
# observed. Claude's identical Bash call is then blocked (exit 2) and handed
# the exit code, the end of the output and the full log path instead, so the
# suite runs once per call, not twice; a run that did not complete is not
# blocked. The result recorded in test_runs is the one harness-os saw. See
# gates.ts's red-phase check and test-runs.ts's recordTestRun for what
# consumes this, and plan §12.3 for the residual gap this doesn't close (a
# fabricated direct `gate-check --mode record-test-run` call bypassing this
# hook entirely).
# 120s bound (Open Item, see plan §12.3, HARNESS_TEST_TIMEOUT_SECONDS): a hung
# test command must not stall Claude Code's tool call forever.
#
# The time limit is perl's alarm, not GNU `timeout` (absent on macOS: every run then exited 127 and
# was recorded as RED without a single test running). A run that did not complete is not evidence of
# anything and is not recorded: 126/127 (not runnable, including perl missing) and 142 (SIGALRM, the
# limit). The gate stays as it was, which for a never-observed RED means closed.
# The test command runs in its own process group; at the limit, and after it exits, the whole group is
# killed, so servers or workers it started cannot outlive it.
if [[ "$HARNESS_TOOL_NAME" == "Bash" && -n "$HARNESS_MATCHED_TEST_COMMAND" ]]; then
  trap - ERR
  set +e
  TEST_LIMIT="${HARNESS_TEST_TIMEOUT_SECONDS:-120}"
  # One log per project, overwritten each run, so logs do not pile up in the temp folder.
  TEST_LOG="${TMPDIR:-/tmp}/harness-test-$(printf '%s' "$HARNESS_PROJECT_PATH" | cksum | cut -d' ' -f1).log"
  TEST_EXIT=$(cd "$HARNESS_PROJECT_PATH" && perl -e '
    my $limit = shift;
    my $pid = fork; exit 127 unless defined $pid;
    if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127 }
    $SIG{ALRM} = sub { kill "KILL", -$pid; exit 142 };
    alarm $limit;
    waitpid($pid, 0); my $status = $?;
    alarm 0; if (kill "TERM", -$pid) { select(undef, undef, undef, 0.2); kill "KILL", -$pid }
    exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
  ' "$TEST_LIMIT" bash -c "$HARNESS_MATCHED_TEST_COMMAND" >"$TEST_LOG" 2>&1; echo $?)
  case "$TEST_EXIT" in
    126 | 127 | 142)
      # Not evidence: let Claude's own call run so it sees why.
      rm -f "$TEST_LOG"
      echo "[enforce-gate] this test command did not complete (exit $TEST_EXIT: not runnable, or stopped after ${TEST_LIMIT}s); nothing recorded." >&2
      ;;
    *)
      RECORD_JSON=$(docker exec harness_gate_daemon node cli/dist/gate-check.js \
        --mode record-test-run \
        --project-path "$HARNESS_PROJECT_PATH" \
        --command "$HARNESS_MATCHED_TEST_COMMAND" \
        --exit-code "$TEST_EXIT" 2>&1)
      RECORD_STATUS=$?
      # The suite just ran; running Claude's identical call again would double every test run. Block it
      # (exit 2) and hand Claude the result instead: exit code, the end of the output, the full log.
      {
        if [[ $RECORD_STATUS -eq 0 ]]; then
          echo "[enforce-gate] harness-os ran this test command and recorded it (exit $TEST_EXIT): $RECORD_JSON"
        else
          echo "[enforce-gate] harness-os ran this test command (exit $TEST_EXIT) but the result was NOT recorded: $RECORD_JSON"
        fi
        echo "[enforce-gate] This is the test result, not an error; the command is not run a second time. Command: $HARNESS_MATCHED_TEST_COMMAND"
        if [[ "$HARNESS_MATCHED_TEST_COMMAND" != "$(printf '%s' "$HARNESS_BASH_COMMAND" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" ]]; then
          echo "[enforce-gate] Your full command was: $HARNESS_BASH_COMMAND -- everything beyond the command above was NOT run; run it separately if you still need it."
        fi
        echo "[enforce-gate] full output: $TEST_LOG"
        echo "--- last ${HARNESS_TEST_OUTPUT_LINES:-80} lines ---"
        tail -n "${HARNESS_TEST_OUTPUT_LINES:-80}" "$TEST_LOG"
      } >&2
      exit 2
      ;;
  esac
  set -e
  trap 'echo "{\"action\":\"internal_error\",\"reason\":\"enforce-gate.sh failed unexpectedly - failing closed (CONST-CORE-004)\"}" >&2; exit 2' ERR
fi

# Before/after snapshot for post-bash-revert.sh, which then judges only what this call changed.
# It refuses (exit 2) while a tracked config file is a symlink.
if [[ "$HARNESS_TOOL_NAME" == "Bash" ]]; then
  if ! node "$SCRIPT_DIR/bash-snapshot.mjs" save "$HARNESS_PROJECT_PATH" "$HARNESS_TOOL_USE_ID"; then
    exit 2
  fi
fi

# Conservative heuristic (Open Item #8): a Bash call with no recognized write
# target is not gated here. post-bash-revert.sh's git-diff backstop
# (§2.1 component 4) is what catches whatever this misses — a false negative
# here is not a silent bypass of the whole mechanism.
if [[ "$HARNESS_TOOL_NAME" == "Bash" && -z "$HARNESS_FILE_PATH" ]]; then
  exit 0
fi

# `trap ... ERR` fires on any qualifying failing command regardless of
# set -e/+e — it is NOT gated by errexit being active, only by the same
# exemption list (bash gotcha, confirmed empirically: the trap fired on
# gate-check.js's *intentional* nonzero exit here, stomping the real
# directive JSON with the generic internal_error message). Disable the trap
# for this one deliberate exit-status check, then restore it.
trap - ERR
set +e
RESULT_JSON=$(docker exec harness_gate_daemon node cli/dist/gate-check.js \
  --project-path "$HARNESS_PROJECT_PATH" \
  --tool "$HARNESS_TOOL_NAME" \
  --file "$HARNESS_FILE_PATH" 2>&1)
STATUS=$?
set -e
trap 'echo "{\"action\":\"internal_error\",\"reason\":\"enforce-gate.sh failed unexpectedly - failing closed (CONST-CORE-004)\"}" >&2; exit 2' ERR

if [[ $STATUS -ne 0 ]]; then
  # Directive-shaped JSON (§2.1) — same envelope as directives.ts — so Claude
  # can read it from stderr and self-correct on its next turn.
  echo "$RESULT_JSON" >&2
  exit 2
fi

exit 0
