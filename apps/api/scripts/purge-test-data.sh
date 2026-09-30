#!/usr/bin/env bash
# Removes the accounts the live suites created, through the Worker.
#
# One SQL statement used to do this, deleting the `@example.test` user rows from local D1
# and letting the cascade take their notes. The notes live in per-account objects now, and
# only the Worker can reach one, so the purge is a route the running dev server answers —
# `POST /api/admin/test/purge-fixtures`, which exists only when the Worker was started by
# `pnpm dev` (it passes ALLOW_TEST_CREDENTIALS=1). The suites need that server running
# anyway, so this runs after them against the same one.
#
# API_URL names the Worker, as it does for the suites; unset, this checkout's usual port is
# derived the way `pnpm dev` derives it — which is where `pnpm dev` started looking, not
# necessarily where it landed: when the usual pair was taken it steps to the next free one
# and says so on its first line. Set API_URL to that when the two differ.
#
# `--fail-with-body` so a refused purge fails the script: a Worker started without
# ALLOW_TEST_CREDENTIALS answers 404 here, and a purge that "succeeded" with that answer
# would leave the fixtures piling up unnoticed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${API_URL:-}" ]; then
  eval "$(node ../../scripts/ports.mjs)"
  API_URL="http://localhost:$API_PORT"
fi

body=$(curl -sS --fail-with-body -X POST "$API_URL/api/admin/test/purge-fixtures") || {
  echo "purge refused or unreachable at $API_URL: ${body:-no response}" >&2
  echo "Is the dev server running there, started by pnpm dev (ALLOW_TEST_CREDENTIALS=1)? If it printed a" >&2
  echo "different port than the derived one, set API_URL=http://localhost:<that port>." >&2
  exit 1
}
echo "purged test fixtures: $body"
