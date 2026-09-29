#!/usr/bin/env bash
# Wipes local development state: D1, R2 and the per-account note stores.
#
# The in-app sweep is scoped to the signed-in user's prefix, so it cannot reclaim objects
# belonging to accounts that no longer exist — test fixtures leave those behind by the
# hundred. This clears everything and rebuilds the schema from migrations. The note
# stores (`do/`) go too, for the reason reset-local-db.sh gives: an object with no account
# behind it is a ghost.
#
# Local only. It never touches anything remote.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE=".wrangler/state/v3"
BACKUP_DIR=".wrangler/backups"

STAMP=$(date +%Y%m%d-%H%M%S)
for dir in d1 do; do
  if [ -d "$STATE/$dir" ]; then
    mkdir -p "$BACKUP_DIR"
    cp -R "$STATE/$dir" "$BACKUP_DIR/$dir-$STAMP"
    echo "backed up local $dir -> $BACKUP_DIR/$dir-$STAMP"
  fi
done

rm -rf "$STATE/d1" "$STATE/r2" "$STATE/do"
npx wrangler d1 migrations apply DB --local --env local
echo "local d1, r2 and note stores cleared, schema rebuilt"
