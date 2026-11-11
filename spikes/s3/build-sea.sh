#!/bin/sh
# P0-S3-T5: build the SEA forwarder (code cache on and off) with --build-sea, then ad-hoc sign. Homebrew's Node is a
# shared-library build with SEA disabled, so this uses the checksum-verified official Node 26.10.0 tarball in
# .cache/node-official (owner-approved, D-P0-21). Run from the repo root after `npm run spike:build`.
set -eu
SEA_NODE="${XAIBO_SEA_NODE:-.cache/node-official/node-v26.10.0-darwin-arm64/bin/node}"
[ -x "$SEA_NODE" ] || { echo "build-sea: official Node not found ($SEA_NODE)" >&2; exit 1; }
mkdir -p .cache/sea
for cfg in spikes/s3/sea-config.json spikes/s3/sea-config.nocache.json; do
  "$SEA_NODE" --build-sea "$cfg"
done
for bin in .cache/sea/xaibo-forwarder-sea .cache/sea/xaibo-forwarder-sea-nocache; do
  codesign --remove-signature "$bin"
  codesign --sign - "$bin"
done
