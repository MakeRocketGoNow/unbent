#!/usr/bin/env bash
# Boot an emulator (if none running) and launch the already-installed debug build.
set -euo pipefail

ANDROID_SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_SDK/platform-tools/adb"
EMULATOR="$ANDROID_SDK/emulator/emulator"
APP_ID="app.unbent.android.debug"
AVD="${AVD_NAME:-Pixel_9_API_36}"

if ! "$ADB" get-state 2>/dev/null | grep -q device; then
  echo "No emulator running, booting $AVD..."
  "$EMULATOR" -avd "$AVD" -no-snapshot-save >/dev/null 2>&1 &
  "$ADB" wait-for-device
  "$ADB" shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'
fi

if ! "$ADB" shell pm list packages | grep -q "$APP_ID"; then
  echo "error: $APP_ID is not installed on this device. Run 'pnpm android:build' first." >&2
  exit 1
fi

echo "Launching $APP_ID..."
"$ADB" shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null
