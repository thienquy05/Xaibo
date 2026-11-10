#!/bin/bash
# P0-T05 isolated temp-profile runner. Always run unsandboxed (OQ-X2); always wraps the command in the
# generated read/write-deny sandbox-exec profile under a clean env, supervised as one process group.
# Usage: in-profile.sh [--spike <id>] [--gemini-layout unset|custom] <agent> <slot> -- <cmd...>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
planfile="$(mktemp)"
trap 'rm -f "$planfile"' EXIT
node "$here/in-profile.ts" prepare "$@" > "$planfile"
plan=()
while IFS= read -r -d '' x; do plan+=("$x"); done < "$planfile"
cwd=${plan[0]}; vagent=${plan[1]}; token=${plan[2]}; pids=${plan[3]}; n=${plan[4]}
prefix=("${plan[@]:5:n}")
cmd=("${plan[@]:5+n}")
cd "$cwd"

# Version freeze check, only when the command is the agent itself (no agent binary runs otherwise).
version() { "${prefix[@]}" "$vagent" --version 2>/dev/null | head -1 || true; }
[ -n "$vagent" ] && before="$(version)"
rc=0
/usr/bin/perl "$here/supervise.pl" "$token" "$pids" -- "${prefix[@]}" "${cmd[@]}" || rc=$?
if [ -n "$vagent" ]; then
  after="$(version)"
  printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$before" "$after" >> "$(dirname "$pids")/versions.log"
  if [ "$before" != "$after" ]; then echo "in-profile: agent version changed during the run; run invalid" >&2; rc=124; fi
fi
exit "$rc"
