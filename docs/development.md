# Development

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # then fill in BETTER_AUTH_SECRET
pnpm migrate:local
pnpm dev
```

The SPA runs on :5173 and proxies `/api/*` to the Worker on :8787, so sessions are same-origin
and there is no CORS in development.

## Worktrees

A second checkout needs a second pair of ports, or its Vite lands on top of the first one's
Worker and every sign-in is refused as CSRF. `pnpm dev` derives the pair from the checkout
and prints it; the main checkout always keeps 5173/8787.

```bash
git worktree add ../unbent-feature feature
cd ../unbent-feature
pnpm worktree:setup
pnpm dev          # web http://localhost:5217  api http://localhost:8817
```

`worktree:setup` copies the gitignored files git cannot bring across (`.dev.vars`,
`local.properties`), installs, and seeds the worktree's local state with a copy of the main
checkout's (D1, R2 and the per-account note stores under `do/`) so the same notes are
there, and because the session cookie on localhost is host-only and ports do not scope
cookies, the browser arrives already signed in. The copy is a snapshot: the two drift apart
from then on, which is the point, since a branch's migrations must not reach the main
checkout's schema. `--fresh` starts empty instead.

A Claude Code session opened in a worktree runs `worktree:setup --fresh` on its own, once,
through the `SessionStart` hook in `.claude/settings.json` (`scripts/worktree-autosetup.sh`).
It only acts in a worktree that has no dependencies or no local database yet, never in the
main checkout, and always starts empty: copying your notes into a worktree is a choice you
make by running `pnpm worktree:setup` without `--fresh` yourself.

Social sign-in is the one thing a worktree does not get for free: Google and GitHub match
the redirect URI including its port, so a worktree's port has to be registered with the
provider to use it. A password (`pnpm dev` turns password sign-up on for every local
Worker) or the sign-in code printed to the Worker console needs nothing registered.
