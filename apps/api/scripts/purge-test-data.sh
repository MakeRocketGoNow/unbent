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
# API_URL names the Worker, as it does for the suites; unset, this checkout's own port is
# derived the way `pnpm dev` derives it.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${API_URL:-}" ]; then
  eval "$(node ../../scripts/ports.mjs)"
  API_URL="http://localhost:$API_PORT"
fi

body=$(curl -sS -X POST "$API_URL/api/admin/test/purge-fixtures") || {
  echo "could not reach $API_URL — is the dev server running?" >&2
  exit 1
}
echo "purged test fixtures: $body"
