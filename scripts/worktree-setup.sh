#!/usr/bin/env bash
# Make a freshly added worktree runnable.
#
# `git worktree add` brings across tracked files and nothing else, so a new worktree has no
# secrets, no dependencies and no local database — a Worker started there has no
# BETTER_AUTH_SECRET, and the SPA has nothing to show. This copies what git left behind.
#
# Local state is seeded by copying the main checkout's D1 and R2 rather than shared: two
# Miniflare processes on one SQLite file is not something Miniflare promises to survive,
# and a branch's migration must not be able to alter the main checkout's schema. The copy
# brings the sessions table with it, and the session cookie on localhost is host-only —
# ports do not scope cookies — so the browser arrives at the worktree's port already signed
# in, with the same notes to look at.
#
# Idempotent: anything already present is left alone. --fresh skips the seed, for a
# worktree that wants an empty database (the isolation suite, say).
#
# Claude-created worktrees get the two gitignored files from .worktreeinclude instead;
# running this afterwards is still worth it for dependencies, state and the ports.
set -euo pipefail

FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    *) echo "usage: pnpm worktree:setup [--fresh]" >&2; exit 2 ;;
  esac
done

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

# The main checkout is the directory holding the shared git dir: <main>/.git.
COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
MAIN=$(dirname "$COMMON")

# Stop rather than act: the main checkout is where everything is copied *from*, and the
# steps below would run migrations against the database a dev server is probably using.
if [ "$MAIN" = "$ROOT" ]; then
  echo "$ROOT is the main checkout, not a worktree — nothing to set up."
  echo "For a first run here: pnpm install && pnpm migrate:local"
  exit 0
fi

copy_from_main() {
  local rel="$1"
  if [ -e "$ROOT/$rel" ]; then
    echo "have    $rel"
  elif [ -e "$MAIN/$rel" ]; then
    mkdir -p "$(dirname "$ROOT/$rel")"
    cp "$MAIN/$rel" "$ROOT/$rel"
    echo "copied  $rel"
  else
    echo "missing $rel (not in $MAIN either)"
  fi
}

copy_from_main apps/api/.dev.vars
copy_from_main apps/android/local.properties

pnpm install

STATE="$ROOT/apps/api/.wrangler/state/v3"
if [ -d "$STATE/d1" ]; then
  echo "have    local d1"
elif [ "$FRESH" = 1 ]; then
  echo "skipped local state seed (--fresh)"
else
  MAIN_STATE="$MAIN/apps/api/.wrangler/state/v3"
  mkdir -p "$STATE"
  # d1, r2 and do — the objects that hold each account's notes — but not `cache`, which is
  # disposable, or `observability`, which is hundreds of megabytes of logs that mean
  # nothing outside the run that wrote them.
  for dir in d1 r2 do; do
    if [ -d "$MAIN_STATE/$dir" ]; then
      cp -R "$MAIN_STATE/$dir" "$STATE/$dir"
      echo "seeded  $dir from $MAIN"
    fi
  done
fi

# On a seeded copy this applies whatever the branch adds on top of the schema it copied;
# on a fresh one it builds the schema from nothing.
pnpm migrate:local

# Write .claude/launch.json for this checkout's port, and report the pair.
eval "$(node "$ROOT/scripts/ports.mjs" --sync-launch)"
echo
echo "pnpm dev  ->  web http://localhost:$WEB_PORT  api http://localhost:$API_PORT"
echo "Social sign-in needs that SPA port registered with the provider; a password or the"
echo "sign-in code printed to the Worker console needs nothing."
