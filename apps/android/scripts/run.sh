#!/usr/bin/env bash
# Boot an emulator (if none running) and launch the already-installed debug build.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_SDK/platform-tools/adb"
EMULATOR="$ANDROID_SDK/emulator/emulator"
GRADLE_APP="$DIR/app"
# The debug build's id, resolved the way Gradle resolves it — local.properties, then the
# environment, then the default in build.gradle.kts — so a fork's own id and a rename of
# the default both reach here without an edit. Sets APP_ID.
# shellcheck source=app-id.sh
. "$DIR/scripts/app-id.sh"
AVD="${AVD_NAME:-Pixel_9_API_36}"

if ! "$ADB" get-state 2>/dev/null | grep -q device; then
  # Only a person at a terminal may boot one. An emulator started from an agent's shell has
  # no GUI session: it renders and answers adb, but its window discards every real mouse
  # click, so it looks healthy to the agent and is unusable for the person in front of it.
  # Booting it is also what puts the AVD's default_boot snapshot at risk. The Bash hook in
  # .claude/settings.json cannot see this launch, since the agent typed `pnpm android`, so
  # the check is here: a TTY on stdin, which a terminal has and an agent's shell does not.
  if [ ! -t 0 ]; then
    echo "error: no emulator running, and this is not an interactive terminal." >&2
    echo "       Start $AVD yourself (Android Studio Device Manager, or run this" >&2
    echo "       script from your own terminal), then run this again." >&2
    exit 1
  fi
  echo "No emulator running, booting $AVD..."
  "$EMULATOR" -avd "$AVD" -no-snapshot-save >/dev/null 2>&1 &
  "$ADB" wait-for-device
  "$ADB" shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'
fi

if ! "$ADB" shell pm list packages | grep -q "$APP_ID"; then
  echo "error: $APP_ID is not installed on this device. Run 'pnpm android:build' first." >&2
  exit 1
fi

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
