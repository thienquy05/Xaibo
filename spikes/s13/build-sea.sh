#!/bin/sh
# P0-S13-T5: build the statusLine tee as a SEA (ES module entry) with the same official Node as spikes/s3/build-sea.sh
# (D-P0-21), then ad-hoc sign. Run from the repo root after `npm run spike:build`.
set -eu
SEA_NODE="${XAIBO_SEA_NODE:-.cache/node-official/node-v26.10.0-darwin-arm64/bin/node}"
[ -x "$SEA_NODE" ] || { echo "build-sea: official Node not found ($SEA_NODE)" >&2; exit 1; }
mkdir -p .cache/sea
"$SEA_NODE" --build-sea spikes/s13/sea-config.json
codesign --remove-signature .cache/sea/xaibo-tee-sea
codesign --sign - .cache/sea/xaibo-tee-sea
