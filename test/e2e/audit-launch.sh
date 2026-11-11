#!/bin/sh
# Playwright launches this as the Electron executable (P1-T05): exec keeps one pid, so the app (packaged binary or the
# unpackaged Electron) runs under the kill-on-attempt profile. --no-sandbox: Chromium's sandbox cannot start inside
# another Seatbelt profile (S10). The two defaults stop macOS window restoration after a killed run (argument domain).
exec /usr/bin/sandbox-exec -f "$XAIBO_AUDIT_PROFILE" "$XAIBO_AUDIT_BIN" "$@" --no-sandbox -ApplePersistenceIgnoreState YES -NSQuitAlwaysKeepsWindows NO
