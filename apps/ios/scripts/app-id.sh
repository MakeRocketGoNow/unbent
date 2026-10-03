#!/usr/bin/env bash
# The debug build's bundle id, resolved the way Xcode resolves it — Config/*.xcconfig, then
# Local.xcconfig — so a fork's own id reaches the scripts without an edit. Sourced; needs
# DIR, sets APP_ID.

APP_ID="$(xcodebuild -project "$DIR/Unbent.xcodeproj" -scheme Unbent -configuration Debug -showBuildSettings 2>/dev/null \
  | awk -F' = ' '/ PRODUCT_BUNDLE_IDENTIFIER = /{print $2; exit}')"
if [ -z "$APP_ID" ]; then
  echo "error: could not read the bundle id from $DIR/Unbent.xcodeproj" >&2
  exit 1
fi
