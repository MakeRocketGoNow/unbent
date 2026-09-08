#!/usr/bin/env bash
# Boot an emulator (if none running), build + install the debug build, then launch it.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_SDK/platform-tools/adb"
EMULATOR="$ANDROID_SDK/emulator/emulator"
GRADLE_APP="$DIR/app"
# The debug build's id, read from Gradle rather than written here.
#
# It was written here, and a rename to com.makerocketgonow.unbent left these scripts
# pointing at an app that no longer existed: the build and install both succeeded, and only
# the launch failed, with "no launcher activity" — which reads like a manifest problem
# rather than a stale constant two directories away. Deriving it means the next rename
# needs no edit here at all.
GRADLE_BUILD="$GRADLE_APP/build.gradle.kts"
BASE_ID="$(sed -n 's/^ *applicationId *= *"\(.*\)".*/\1/p' "$GRADLE_BUILD")"
SUFFIX="$(sed -n 's/^ *applicationIdSuffix *= *"\(.*\)".*/\1/p' "$GRADLE_BUILD")"
if [ -z "$BASE_ID" ]; then
  echo "error: could not read applicationId from $GRADLE_BUILD" >&2
  exit 1
fi
APP_ID="${BASE_ID}${SUFFIX}"
AVD="${AVD_NAME:-Pixel_9_API_36}"

if ! "$ADB" get-state 2>/dev/null | grep -q device; then
  echo "No emulator running, booting $AVD..."
  "$EMULATOR" -avd "$AVD" -no-snapshot-save >/dev/null 2>&1 &
  "$ADB" wait-for-device
  "$ADB" shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'
fi

echo "Building and installing debug build..."
"$DIR/gradlew" -p "$DIR" installDebug

# `am start` on the resolved launcher activity, not `monkey`. Monkey refuses to run on a
# device with no hardware keys — "SYS_KEYS has no physical keys", exit 251 — which every
# recent gesture-navigation AVD is, and it bails before launching anything, so `set -e`
# turned a working install into a failed command. Resolving the activity rather than
# naming it keeps this working if the launcher entry point is ever renamed.
echo "Launching $APP_ID..."
ACTIVITY="$("$ADB" shell cmd package resolve-activity --brief "$APP_ID" | tail -1 | tr -d '\r')"
if [ -z "$ACTIVITY" ] || [ "$ACTIVITY" = "No activity found" ]; then
  echo "error: no launcher activity for $APP_ID" >&2
  exit 1
fi
"$ADB" shell am start -n "$ACTIVITY" >/dev/null
