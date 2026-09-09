#!/usr/bin/env bash
# Give PostHog the source maps for this build, so a stack trace names real code.
#
# Without this an error report reads `index-CDkkheec.js:1:48213`, which locates nothing:
# the bundle is minified and its names are gone. The maps are already built —
# `build.sourcemap` is on in vite.config.ts — so this only hands them over.
#
# `sourcemap process` is inject-then-upload in one pass. Inject is the half that must happen
# before the deploy: it rewrites the built JS with a chunk id comment, and PostHog matches a
# map to a stack by that id, so uploading maps whose chunk ids are not in the served bundle
# achieves nothing. That ordering is why this is a step in `release` rather than something
# that could run afterwards.
#
# A no-op without a key, which is the ordinary case: a self-hoster running `pnpm release` has
# no PostHog project, and CI on a fork has no secrets. Neither should fail a deploy over an
# optional extra. The maps stay in `dist` either way — they are already served publicly, and
# withdrawing them is a separate decision from this one.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${POSTHOG_CLI_API_KEY:-}" ]; then
  echo "sourcemaps: no POSTHOG_CLI_API_KEY, skipping upload"
  exit 0
fi

if [ -z "${POSTHOG_CLI_PROJECT_ID:-}" ]; then
  echo "sourcemaps: POSTHOG_CLI_API_KEY is set but POSTHOG_CLI_PROJECT_ID is not" >&2
  exit 1
fi

if [ ! -d dist/assets ]; then
  echo "sourcemaps: dist/assets is missing — run the build first" >&2
  exit 1
fi

echo "sourcemaps: injecting chunk ids and uploading to PostHog"
pnpm exec posthog-cli sourcemap process --directory dist/assets
