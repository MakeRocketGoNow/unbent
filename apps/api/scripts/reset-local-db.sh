#!/usr/bin/env bash
# Rebuilds the local D1 from migrations, backing up first.
#
# Exists because `rm -rf .wrangler/state/v3/d1` destroys real local notes with no undo —
# it has already cost one set. Testing a migration change should not risk your own data.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE=".wrangler/state/v3/d1"
BACKUP_DIR=".wrangler/backups"

if [ -d "$STATE" ]; then
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  cp -R "$STATE" "$BACKUP_DIR/d1-$STAMP"
  echo "backed up local d1 -> $BACKUP_DIR/d1-$STAMP"
fi

rm -rf "$STATE"
npx wrangler d1 migrations apply DB --local
echo "local d1 rebuilt from migrations"
