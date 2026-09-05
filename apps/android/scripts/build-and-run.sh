#!/usr/bin/env bash
# Boot an emulator (if none running), build + install the debug build, then launch it.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_SDK/platform-tools/adb"
EMULATOR="$ANDROID_SDK/emulator/emulator"
APP_ID="app.unbent.android.debug"
AVD="${AVD_NAME:-Pixel_8_API_35}"

if ! "$ADB" get-state 2>/dev/null | grep -q device; then
  echo "No emulator running, booting $AVD..."
  "$EMULATOR" -avd "$AVD" -no-snapshot-save >/dev/null 2>&1 &
  "$ADB" wait-for-device
  "$ADB" shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'
fi

echo "Building and installing debug build..."
"$DIR/gradlew" -p "$DIR" installDebug

echo "Launching $APP_ID..."
"$ADB" shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null
