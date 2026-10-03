#!/usr/bin/env bash
# Boot a simulator (if none running) and launch the already-installed debug build.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=simulator.sh
. "$DIR/scripts/simulator.sh"
# shellcheck source=app-id.sh
. "$DIR/scripts/app-id.sh"

if ! xcrun simctl get_app_container "$UDID" "$APP_ID" >/dev/null 2>&1; then
  echo "error: $APP_ID is not installed on this simulator. Run 'pnpm ios:build' first." >&2
  exit 1
fi

echo "Launching $APP_ID..."
xcrun simctl launch "$UDID" "$APP_ID" >/dev/null
