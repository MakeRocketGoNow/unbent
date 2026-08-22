#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npx wrangler d1 execute unbent --local \
  --command "DELETE FROM user WHERE email LIKE '%@example.test';" >/dev/null
echo "purged test fixtures from local d1"
