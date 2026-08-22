#!/usr/bin/env bash
# Wipes local development state: D1 and R2 both.
#
# The in-app sweep is scoped to the signed-in user's prefix, so it cannot reclaim objects
# belonging to accounts that no longer exist — test fixtures leave those behind by the
# hundred. This clears everything and rebuilds the schema from migrations.
#
# Local only. It never touches remote D1 or R2.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE=".wrangler/state/v3"
BACKUP_DIR=".wrangler/backups"

if [ -d "$STATE/d1" ]; then
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  cp -R "$STATE/d1" "$BACKUP_DIR/d1-$STAMP"
  echo "backed up local d1 -> $BACKUP_DIR/d1-$STAMP"
fi

rm -rf "$STATE/d1" "$STATE/r2"
npx wrangler d1 migrations apply unbent --local
echo "local d1 and r2 cleared, schema rebuilt"
