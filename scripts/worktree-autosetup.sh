#!/usr/bin/env bash
# SessionStart hook: make a worktree runnable the first time a Claude session opens in it.
#
# `git worktree add` brings tracked files and nothing else, and the desktop app adds only
# the two gitignored files in .worktreeinclude. So a session that starts in a worktree the
# app just made has no dependencies and no local database, and nothing runs
# `pnpm worktree:setup` until someone remembers to — which showed up as a Worker with no
# schema and a note in a hand-off saying the state still needed seeding. This runs it,
# once, when a session starts somewhere it is needed.
#
# Three exits before it does anything, in order of cost:
#   - not inside a git checkout at all;
#   - the main checkout, which `worktree:setup` refuses anyway and which is the user's;
#   - a worktree that already has dependencies and a local D1, where a re-run would only
#     cost the seconds `pnpm install` takes to say "already up to date".
#
# `--fresh`, always: an empty migrated database rather than a copy of the main checkout's.
# Copying the real corpus is a decision about the user's disk and their data, so it stays
# a command a person runs on purpose. `pnpm seed:demo` fills a fresh worktree with sample
# notes once its server is up; the worktree-up skill does both.
#
# Output goes to the session as context, so the assistant knows the worktree was just set
# up and which ports it got, rather than discovering an empty database on its own.
set -euo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ "$(dirname "$common")" != "$root" ] || exit 0

if [ -d "$root/node_modules" ] && [ -d "$root/apps/api/.wrangler/state/v3/d1" ]; then
  exit 0
fi

echo "New worktree at $root: running pnpm worktree:setup --fresh (dependencies, empty local database, ports)."
if [ "${WORKTREE_AUTOSETUP_DRY_RUN:-}" = "1" ]; then
  echo "(dry run: not running it)"
  exit 0
fi
cd "$root"
# Only the tail: the migration table and the ports line are what a session needs to see;
# the install's progress bars are not.
pnpm worktree:setup --fresh 2>&1 | tail -4
