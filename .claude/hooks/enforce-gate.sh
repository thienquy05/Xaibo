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
# observed. Claude's own identical Bash call still runs normally right after
# (not blocked here), so it sees full test output as usual; this block only
# ensures a *trustworthy* copy of the result reaches test_runs first. See
# gates.ts's red-phase check and test-runs.ts's recordTestRun for what
# consumes this, and plan §12.3 for the residual gap this doesn't close (a
# fabricated direct `gate-check --mode record-test-run` call bypassing this
# hook entirely).
# 120s bound (Open Item, see plan §12.3): a hung test command must not stall
# Claude Code's tool call forever. `timeout` sends SIGTERM and the shell sees
# exit 124, which gets recorded as a (possibly spurious) RED — a known,
# documented imprecision, not a silent hang.
#
# The time limit is perl's alarm, not GNU `timeout` (absent on macOS: every run then exited 127 and
# was recorded as RED without a single test running). A run that did not complete is not evidence of
# anything and is not recorded: 126/127 (not runnable, including perl missing) and 142 (SIGALRM, the
# limit). The gate stays as it was, which for a never-observed RED means closed.
# ponytail: the alarm stops the test command itself; processes it started can outlive it
if [[ "$HARNESS_TOOL_NAME" == "Bash" && -n "$HARNESS_MATCHED_TEST_COMMAND" ]]; then
  trap - ERR
  set +e
  TEST_LIMIT="${HARNESS_TEST_TIMEOUT_SECONDS:-120}"
  TEST_EXIT=$(cd "$HARNESS_PROJECT_PATH" && perl -e 'alarm shift; exec @ARGV or exit 127' "$TEST_LIMIT" bash -c "$HARNESS_MATCHED_TEST_COMMAND" >/dev/null 2>&1; echo $?)
  case "$TEST_EXIT" in
    126 | 127 | 142)
      echo "[enforce-gate] this test command did not complete (exit $TEST_EXIT: not runnable, or stopped after ${TEST_LIMIT}s); nothing recorded." >&2
      ;;
    *)
      RECORD_JSON=$(docker exec harness_gate_daemon node cli/dist/gate-check.js \
        --mode record-test-run \
        --project-path "$HARNESS_PROJECT_PATH" \
        --command "$HARNESS_MATCHED_TEST_COMMAND" \
        --exit-code "$TEST_EXIT" 2>&1)
      echo "[enforce-gate] harness-os independently ran and recorded this test command (exit $TEST_EXIT): $RECORD_JSON" >&2
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
