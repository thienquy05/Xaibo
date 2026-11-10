#!/bin/bash
# P0-T06 steps 2-5 for one agent. The OWNER runs this in their own terminal, with no real session of that agent
# running (for claude: every Claude Code session exited, incl. editor extensions). Guard output is counts only.
# Usage: bash spikes/shared/signin.sh claude|codex|gemini
set -euo pipefail
agent="${1:-}"
repo="$(cd "$(dirname "$0")/../.." && pwd -P)"
guard() { node "$repo/spikes/shared/guard.ts" "$@"; }
run() { bash "$repo/spikes/shared/in-profile.sh" "$@"; }
project="$repo/.cache/spike-projects/p0"

case "$agent" in
  claude|codex|gemini) ;;
  *) echo "usage: signin.sh claude|codex|gemini" >&2; exit 2 ;;
esac
mkdir -p "$project"
[ -f "$project/README.txt" ] || echo synthetic > "$project/README.txt"

echo "== step 2: guard snapshot"
guard snapshot "pre-login-$agent"

echo "== step 3: auth probe in the temp profile (must NOT show a login)"
case "$agent" in
  claude) run claude a -- claude auth status || true ;;
  codex) run codex a -- codex login status || true ;;
  gemini) (cd "$project" && run --spike p0 gemini a -- gemini -p "Reply with the single word OK.") || true ;;
esac
if ! guard compare "pre-login-$agent"; then echo "STOP: guard did not MATCH after the probe. Tell Claude; do not sign in." >&2; exit 1; fi

echo
echo "If the probe above says you are ALREADY signed in, press Ctrl-C now (credentials would be shared)."
read -r -p "Otherwise press Enter to sign in to the TEMP profile... " _

echo "== step 4: sign in (temp profile only)"
case "$agent" in
  claude) run claude a -- claude auth login ;;
  codex) echo "If the browser sign-in fails, re-run and use: codex login --device-auth"
         run codex a -- codex login ;;
  gemini) echo "Pick 'Login with Google' (or your usual method), finish in the browser, then type /quit."
          (cd "$project" && run --spike p0 gemini a -- gemini) ;;
esac

echo "== step 5: guard compare after sign-in"
expect=()
if [ "$agent" = claude ]; then
  svce="Claude Code-credentials-$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1].normalize("NFC")).digest("hex").slice(0,8))' "$HOME/.xaibo-spike-profiles/claude-a/home/.claude")"
  expect=(--expect-new-keychain "$svce")
fi
if guard compare "pre-login-$agent" ${expect[@]+"${expect[@]}"}; then
  echo "DONE: sign-in isolated (MATCH). Tell Claude the result line above."
else
  echo "STOP: guard did not MATCH after sign-in. Tell Claude the result line above; do not use this profile yet." >&2
  exit 1
fi
