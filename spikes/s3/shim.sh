#!/bin/sh
# Models <appdata>/integrations/bin/xaibo-hook (P0-S3-T2): exec the selected forwarder runtime, or exit 0 silently
# when the app or runtime is missing (EC-27). Usage (hook command): shim.sh <agent> <event>
# Inputs: XAIBO_FWD_CANDIDATE (system-node|electron-node|electron-node-asar|sea|sea-nocache), XAIBO_APP (app bundle), XAIBO_REPO (system-node only).
case "${XAIBO_FWD_CANDIDATE:-}" in
  electron-node)
    bin="$XAIBO_APP/Contents/MacOS/XaiboSpike"
    fwd="$XAIBO_APP/Contents/Resources/app.asar.unpacked/build/s3/forwarder.cjs"
    [ -x "$bin" ] && [ -f "$fwd" ] || exit 0
    ELECTRON_RUN_AS_NODE=1 exec "$bin" "$fwd" "$@" ;;
  electron-node-asar)
    bin="$XAIBO_APP/Contents/MacOS/XaiboSpike"
    [ -x "$bin" ] || exit 0
    ELECTRON_RUN_AS_NODE=1 exec "$bin" "$XAIBO_APP/Contents/Resources/app.asar/build/s3/forwarder.cjs" "$@" ;;
  sea|sea-nocache)
    bin="$XAIBO_APP/Contents/Resources/bin/xaibo-forwarder-$XAIBO_FWD_CANDIDATE"
    [ -x "$bin" ] || exit 0
    exec "$bin" "$@" ;;
  system-node)
    command -v node >/dev/null 2>&1 && [ -f "$XAIBO_REPO/spikes/s3/forwarder.cts" ] || exit 0
    exec node "$XAIBO_REPO/spikes/s3/forwarder.cts" "$@" ;;
esac
exit 0
