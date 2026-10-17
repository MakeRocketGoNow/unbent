#!/usr/bin/env bash
# SessionStart hook: make a worktree runnable the first time a Claude session opens in it.
#
# `git worktree add` brings tracked files and nothing else. The desktop app adds the two
# gitignored files in .worktreeinclude and a clone of the main checkout's root
# node_modules, and nothing more: no workspace's node_modules and no local database. So a
# session that starts in a worktree the app just made has no wrangler, vitest or type
# packages and no schema, and nothing runs `pnpm worktree:setup` until someone remembers
# to, which showed up as a Worker with no schema and a note in a hand-off saying the state
# still needed seeding. This runs it, once, when a session starts somewhere it is needed.
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

# The session's folder is the hook input's `cwd`, not this process's working directory.
# The desktop app starts a worktree's session with --project-config-root naming the main
# checkout, so that one checkout's settings and hooks serve every worktree, and Claude Code
# then runs each hook in the main checkout, with CLAUDE_PROJECT_DIR naming it too. Read
# from there, every session looked like one in the main checkout and this script left
# quietly by the second exit above: every worktree the app made from 2026-09-30, when it
# started passing the flag, until 2026-10-17. A CLI started inside a worktree runs the hook
# there, and a person running this by hand passes nothing, so the working directory stays
# the fallback. node rather than a pattern over the JSON, because a path can hold anything
# JSON escapes; it is on the PATH wherever pnpm is.
dir=$PWD
if [ ! -t 0 ]; then
  cwd=$(node -e 'let s = ""
process.stdin.on("data", (c) => (s += c)).on("end", () => {
  try { process.stdout.write(String(JSON.parse(s).cwd ?? "")) } catch {}
})' 2>/dev/null) || cwd=
  if [ -n "$cwd" ] && [ -d "$cwd" ]; then dir=$cwd; fi
fi
cd "$dir"

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
main=$(dirname "$common")
[ "$main" != "$root" ] || exit 0

# Dependencies are judged by the workspaces' node_modules, never the root's. The app's
# clone makes the root look installed, but it finds workspaces only in package.json's
# `workspaces` field, which a pnpm workspace does not use, so apps/*/node_modules never
# arrive with it, and they are where wrangler, vitest and the type packages are linked.
if [ -d "$root/apps/api/node_modules" ] && [ -d "$root/apps/web/node_modules" ] \
  && [ -d "$root/apps/api/.wrangler/state/v3/d1" ]; then
  exit 0
fi

echo "New worktree at $root: running pnpm worktree:setup --fresh (dependencies, empty local database, ports)."
if [ "${WORKTREE_AUTOSETUP_DRY_RUN:-}" = "1" ]; then
  echo "(dry run: not running it)"
  exit 0
fi

# Let the app's clone land first rather than race it. It arrives whole, renamed into place,
# within five seconds of the session starting (three is typical), and `pnpm install` over
# it links the workspaces in seconds where an install from nothing takes minutes. It comes
# only when the main checkout has node_modules and the same lockfile, which is the app's
# own test, so a worktree that will get none does not wait.
if [ ! -e "$root/node_modules" ] && [ -d "$main/node_modules" ] \
  && cmp -s "$main/pnpm-lock.yaml" "$root/pnpm-lock.yaml"; then
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [ -e "$root/node_modules" ] && break
    sleep 0.5
  done
fi

cd "$root"
# Only the tail: the migration table and the ports line are what a session needs to see;
# the install's progress bars are not. A failure exits 0 all the same, with more of the
# tail: a SessionStart hook's output reaches the session only when it succeeds, and one
# that failed quietly would leave the next session as lost as the bug above did.
if ! out=$(pnpm worktree:setup --fresh 2>&1); then
  printf '%s\n' "$out" | tail -20
  echo "pnpm worktree:setup --fresh failed (above). Fix that, then run it by hand in $root."
  exit 0
fi
printf '%s\n' "$out" | tail -4
