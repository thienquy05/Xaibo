#!/bin/bash
# P6-S14-T1 live block (S14, D-P6-14): two CLI starts of one agent/method in a disposable profile, each with the fixed
# prompt and a guard snapshot/compare around it, then the numberless reduction into spikes/s14/evidence/s14.json.
# The OWNER runs this in their own terminal (unsandboxed), with the profile already signed in with that method.
# Usage: bash spikes/s14/run.sh claude a subscription
set -euo pipefail
agent="${1:-}"; slot="${2:-}"; method="${3:-}"
repo="$(cd "$(dirname "$0")/../.." && pwd -P)"
prompt="Reply with the single word OK."
guard() { node "$repo/spikes/shared/guard.ts" "$@"; }
run() { bash "$repo/spikes/shared/in-profile.sh" --spike s14 "$@"; }
case "$agent:$slot:$method" in
  claude:[ab]:subscription|claude:[ab]:api-key|claude:[ab]:cloud-provider|claude:[ab]:gateway) ;;
  codex:[ab]:subscription|codex:[ab]:api-key|codex:[ab]:cloud-provider|codex:[ab]:gateway) ;;
  *) echo "usage: run.sh claude|codex a|b subscription|api-key|cloud-provider|gateway" >&2; exit 2 ;;
esac
project="$repo/.cache/spike-projects/s14"
mkdir -p "$project"
[ -f "$project/README.txt" ] || echo synthetic > "$project/README.txt"
[ -d "$project/.git" ] || git -C "$project" init -q

labels=()
for start in 1 2; do
  label="$agent-$method-start$start"
  echo "== $label: guard snapshot"
  guard snapshot "s14-$label"
  case "$agent" in
    claude)
      settings="$(node "$repo/spikes/s14/collect.ts" settings "$label")"
      echo "Claude opens with the prompt already sent. If it asks to trust the folder, press Enter."
      echo "Wait for the reply (OK) and the status line, then type /exit."
      (cd "$project" && run claude "$slot" -- claude --settings "$settings" "$prompt") || true ;;
    codex) # ready, not run yet (D-P6-14): headless, no tools; trust only for the throwaway project
      (cd "$project" && run codex "$slot" -- codex exec -c "projects.\"$(pwd -P)\".trust_level=\"trusted\"" "$prompt") || true ;;
  esac
  node "$repo/spikes/shared/in-profile.ts" cleanup "$agent" "$slot" > /dev/null 2>&1 || true
  echo "== $label: guard compare"
  if ! guard compare "s14-$label"; then echo "STOP: guard did not MATCH. Tell Claude the result line above; do not continue." >&2; exit 1; fi
  labels+=("$label")
done

echo "== reduce (numberless rows; raw captures stay in .cache/spike-results/s14/raw)"
node "$repo/spikes/s14/collect.ts" reduce "$agent" "$slot" "$method" "${labels[@]}"
echo "DONE: tell Claude the MATCH lines and the rows above."
