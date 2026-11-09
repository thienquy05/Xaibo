#!/bin/bash
# PostToolUse and PostToolUseFailure hook: Bash. Reactive backstop for whatever enforce-gate.sh's
# Bash-write heuristic misses (§2.1 component 4). bash-snapshot.mjs compares the watched files with
# the snapshot enforce-gate.sh took right before this call, so only changes made by this call count;
# edits that were already in the working tree are never touched.
#   - A CONST-CORE-004-tracked config file the call changed, while the config no longer verifies, is
#     restored to its content before the call. What was found is kept in quarantine first: it may be a
#     concurrent edit by someone else, so nothing is lost. Moving HEAD does not exempt this.
#   - A gatedGlobs file the call changed while the gate is closed (no RED run recorded) is flagged to
#     Claude and logged, not reverted: a revert could lose work. Committing it does not hide it; only a
#     file that matches a checked-out commit which existed before the call is left alone.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$(cat)"
eval "$(printf '%s' "$PAYLOAD" | node "$SCRIPT_DIR/parse-tool-call.mjs")"

if [[ "$HARNESS_TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

cd "$HARNESS_PROJECT_PATH"

# Open Item #9: this backstop needs a git repo to diff against. harness init
# should require this precondition; a non-git project just gets a warning,
# not a crash — component 1's PreToolUse gate is still the primary defense.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[post-bash-revert] Warning: $HARNESS_PROJECT_PATH is not a git repository — the revert backstop cannot run (Open Item #9)." >&2
  exit 0
fi

STATUS=0
SNAPSHOT=(node "$SCRIPT_DIR/bash-snapshot.mjs")
CHANGES="$("${SNAPSHOT[@]}" compare "$HARNESS_PROJECT_PATH" "$HARNESS_TOOL_USE_ID")"

while read -r _ FILE; do
  echo "[post-bash-revert] the mode of $FILE was changed, or it became a hard link, during this Bash call — replaced with a fresh copy of its content and mode from before the call (CONST-CORE-004)." >&2
  docker exec harness_gate_daemon node cli/dist/log-revert.js \
    --project-path "$HARNESS_PROJECT_PATH" --file "$FILE" >&2 || true
  STATUS=2
done < <(grep '^MODE ' <<< "$CHANGES" || true)

while read -r _ FILE; do
  echo "[post-bash-revert] $FILE now sits in a folder that leads outside the project (symlink); nothing was changed there. A human should put .claude back as a real folder in the project (CONST-CORE-004)." >&2
  docker exec harness_gate_daemon node cli/dist/log-revert.js \
    --project-path "$HARNESS_PROJECT_PATH" --file "$FILE" >&2 || true
  STATUS=2
done < <(grep '^OUTSIDE ' <<< "$CHANGES" || true)

# Without --file, gate-check checks config integrity only.
if grep -q '^CONFIG ' <<< "$CHANGES" && ! docker exec harness_gate_daemon node cli/dist/gate-check.js \
  --project-path "$HARNESS_PROJECT_PATH" --tool Bash >/dev/null 2>&1; then
  while read -r _ FILE; do
    read -r RESULT DETAIL <<< "$("${SNAPSHOT[@]}" restore "$HARNESS_PROJECT_PATH" "$HARNESS_TOOL_USE_ID" "$FILE")"
    if [[ "$RESULT" == "RESTORED" ]]; then
      echo "[post-bash-revert] $FILE was changed during this Bash call and the config no longer verifies — restored to its content before the call; what was found is kept at $DETAIL (CONST-CORE-004)." >&2
    else
      echo "[post-bash-revert] $FILE was changed during this Bash call and the config no longer verifies — not restored: $DETAIL. Gated writes stay blocked until a human reconciles (CONST-CORE-004)." >&2
    fi
    docker exec harness_gate_daemon node cli/dist/log-revert.js \
      --project-path "$HARNESS_PROJECT_PATH" --file "$FILE" >&2 || true
    STATUS=2
  done < <(grep '^CONFIG ' <<< "$CHANGES")
fi

while read -r _ FILE; do
  if ! docker exec harness_gate_daemon node cli/dist/gate-check.js \
    --project-path "$HARNESS_PROJECT_PATH" --tool Bash --file "$HARNESS_PROJECT_PATH/$FILE" >/dev/null 2>&1; then
    echo "[post-bash-revert] $FILE is gated and this Bash call wrote it while no RED test run is recorded. It was not reverted: record a failing test first, or undo the change (CONST-CORE-002)." >&2
    docker exec harness_gate_daemon node cli/dist/log-revert.js \
      --project-path "$HARNESS_PROJECT_PATH" --file "$FILE" --kind gated >&2 || true
    STATUS=2
  fi
done < <(grep '^GATED ' <<< "$CHANGES" || true)

"${SNAPSHOT[@]}" done "$HARNESS_PROJECT_PATH" "$HARNESS_TOOL_USE_ID"
exit "$STATUS"
