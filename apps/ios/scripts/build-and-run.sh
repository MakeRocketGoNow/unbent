#!/usr/bin/env bash
# Boot a simulator (if none running), build + install the debug build, then launch it.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=simulator.sh
. "$DIR/scripts/simulator.sh"
# shellcheck source=app-id.sh
. "$DIR/scripts/app-id.sh"

# Into apps/ios/build rather than Xcode's shared DerivedData, so the app this installs is
# the one this checkout built: a worktree beside it has its own.
echo "Building the debug build..."
xcodebuild \
  -project "$DIR/Unbent.xcodeproj" \
  -scheme Unbent \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$DIR/build" \
  -quiet \
  build

echo "Installing and launching $APP_ID..."
xcrun simctl install "$UDID" "$DIR/build/Build/Products/Debug-iphonesimulator/Unbent.app"
xcrun simctl launch "$UDID" "$APP_ID" >/dev/null
