#!/bin/sh
# P3-T03: build the hook forwarder as a Node SEA (S3 runtime B) from the compiled out/forwarder/forwarder.js with the
# official static Node in .cache (D-P0-21; Homebrew Node is a shared-library build without SEA), then sign it ad hoc.
# Run from the repo root after `npm run build`; dist:mac does both. Output: .cache/sea/xaibo-forwarder.
# P3-T14: also the statusLine tee, .cache/sea/xaibo-statusline (S13, D-P0-34: its own SEA; execArgvExtension none, so
# NODE_OPTIONS from the agent's environment never reaches it).
set -eu
SEA_NODE="${XAIBO_SEA_NODE:-.cache/node-official/node-v26.10.0-darwin-arm64/bin/node}"
[ -x "$SEA_NODE" ] || { echo "build-forwarder: official Node not found ($SEA_NODE)" >&2; exit 1; }
[ -f out/forwarder/forwarder.js ] && [ -f out/forwarder/statusline-tee.js ] || { echo "build-forwarder: run npm run build first" >&2; exit 1; }
mkdir -p .cache/sea
for name in forwarder statusline; do
  "$SEA_NODE" --build-sea "scripts/$name-sea.json"
  codesign --remove-signature ".cache/sea/xaibo-$name"
  codesign --sign - ".cache/sea/xaibo-$name"
done
