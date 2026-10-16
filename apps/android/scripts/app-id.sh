#!/usr/bin/env bash
# The application id a build of this checkout gets, resolved the way Gradle resolves it.
#
# Sourced by run.sh and build-and-run.sh, which need the *installed* id to find the app on
# a device; run directly, it prints the id and exits. One place rather than two, because
# the id used to be written in both scripts, and a rename left them launching an app that
# no longer existed: the build and install both succeeded, and only the launch failed,
# with "no launcher activity", which reads like a manifest problem rather than a stale
# constant two directories away.
#
# Precedence matches `secret()` in app/build.gradle.kts: `unbent.applicationId` in
# local.properties, then UNBENT_APPLICATION_ID in the environment, then the default the
# build file declares. A fork that publishes its own app sets the first or the second and
# never edits the third.
#
# Sets APP_ID (the debug build's, with the suffix) and BASE_ID (the release build's).

_android_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_gradle_build="$_android_dir/app/build.gradle.kts"
_local_props="$_android_dir/local.properties"

BASE_ID=""
if [ -f "$_local_props" ]; then
  BASE_ID="$(sed -n 's/^unbent\.applicationId=[[:space:]]*//p' "$_local_props" | tail -1)"
fi
if [ -z "$BASE_ID" ]; then
  BASE_ID="${UNBENT_APPLICATION_ID:-}"
fi
if [ -z "$BASE_ID" ]; then
  BASE_ID="$(sed -n 's/^val defaultApplicationId = "\(.*\)".*/\1/p' "$_gradle_build")"
fi
if [ -z "$BASE_ID" ]; then
  echo "error: could not resolve the application id from $_local_props or $_gradle_build" >&2
  return 1 2>/dev/null || exit 1
fi

_suffix="$(sed -n 's/^ *applicationIdSuffix *= *"\(.*\)".*/\1/p' "$_gradle_build")"
APP_ID="${BASE_ID}${_suffix}"

# Run directly rather than sourced: say what was resolved.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "release: $BASE_ID"
  echo "debug:   $APP_ID"
fi
