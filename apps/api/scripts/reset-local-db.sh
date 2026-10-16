#!/usr/bin/env bash
# Rebuilds the local D1 from migrations and clears the local note stores, backing both
# up first.
#
# Exists because `rm -rf .wrangler/state/v3/d1` destroys real local notes with no undo:
# it has already cost one set. Testing a migration change should not risk your own data.
#
# The objects go with the database. Each account's notes live in a Durable Object under
# `do/`, keyed by the user id in `d1/`; reset one without the other and every object is a
# ghost (notes with no account, or accounts whose first open finds an object already full
# of someone else's earlier state) and the copy from D1 that a fresh object runs would
# copy from tables that are now empty.
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

rm -rf "$STATE/d1" "$STATE/do"
npx wrangler d1 migrations apply DB --local --env local
echo "local d1 rebuilt from migrations; local note stores cleared"
