---
name: worktree-down
description: Stop a worktree's dev servers and clean up after branch work: kill the process tree including orphaned children, verify ports are released, and optionally remove the worktree's local database and the worktree itself. Use when finishing branch work in this repo, or when the user says "stop the dev server", "clean up", "shut it down", or "remove that worktree". Do not use to start or seed one: that is worktree-up.
compatibility: Needs a local git checkout of unbent. Stops processes and, with the user's explicit go-ahead, deletes local state.
allowed-tools: Read, Glob, Grep, Bash(git:*), Bash(kill:*), Bash(ps:*), Bash(lsof:*), Bash(curl:*), Bash(du:*), Bash(rm:*)
---

# worktree-down

Leave the machine as you found it. Two halves: **stopping processes**, which you do without
asking, and **deleting things**, which you never do without asking.

## 1. Find what is actually running

Don't kill by remembered PID: a backgrounded task may have already exited, and a stale PID
is a different process by now.

```bash
ps -eo pid,ppid,etime,command | grep -Ei "vite|wrangler|workerd|miniflare|dev\.mjs" | grep -v grep
lsof -nP -iTCP -sTCP:LISTEN | grep -Ei "node|workerd"
```

Confirm each one belongs to *this* worktree before touching it. The command paths include
the worktree directory. Read them. **The user's own dev server on 5173/8787 (the main
checkout) is not yours to stop.** If a process is theirs, leave it and say so.

## 2. Stop the tree, and then its orphans

Kill the parent `scripts/dev.mjs` first:

```bash
kill <dev.mjs pid>
```

**Then look again.** This is the part that catches people out: killing the parent reports
success and exits with SIGTERM (143), but `vite`, `wrangler`, and both `workerd` processes
survive it as orphans and keep holding their ports. Re-run the `ps` from step 1, and kill
whatever is left directly:

```bash
kill <remaining pids>
```

Verify with all three (processes gone, nothing listening, ports refusing connections):

```bash
ps -eo pid,command | grep -Ei "vite|wrangler|workerd|dev\.mjs" | grep -v grep || echo "(none)"
lsof -nP -iTCP -sTCP:LISTEN | grep -Ei "node|workerd" || echo "(none)"
curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:<web>/
```

A released port gives no answer. Don't report the machine clean until all three agree.

Reset any viewport emulation you set in the browser pane back to `desktop`.

## 3. Report what is still on disk

Measure it rather than describing it vaguely:

```bash
du -sh apps/api/.wrangler node_modules
du -sh apps/api/.wrangler/state/v3/*
```

A used worktree typically holds ~800M of `node_modules` and a few MB of `.wrangler` state:
D1, R2, and an `observability` directory that is usually the bulk of it and means nothing
outside the run that wrote it.

## 4. Ask before deleting anything

**Stopping processes is yours to do. Deleting is the user's call, every time.** Check for
work first, and say what you find:

```bash
git status --porcelain
git log --oneline origin/main..HEAD
```

Uncommitted tracked changes, or commits not on `origin`, are a stop condition. Report them
and ask: don't offer deletion as though the work were disposable.

Then, in increasing order of destructiveness, offer only what applies:

**The local database.** The repo's rule is that local notes are disposable *but you ask
first every time*, because the plan is a final import from the real Evernote corpus and the
state may have changed since the last conversation. Prefer the scripts that back up first:

```bash
pnpm --filter @unbent/api db:reset      # rebuild D1 from migrations, backing up first
pnpm --filter @unbent/api reset:local   # D1 and R2 both, backing up D1 first
```

Reach for `rm -rf .wrangler/state/v3/d1` only if the user asks for it specifically. It has
already destroyed real local notes once, which is why those scripts exist.

**The worktree itself.** Destructive and not yours to run unprompted. Give the user the
command rather than executing it on your own initiative:

```bash
git worktree remove .claude/worktrees/<name> --force
git branch -D <branch>
```

If they explicitly ask you to remove it, run it from the **main checkout**, not from inside
the worktree you are deleting.

## Notes

- **Attribute honestly.** If a process died and you didn't kill it, say so. Exit code 143 is
  SIGTERM: something terminated it, which may have been the user.
- Never delete a worktree that still holds unpushed commits or uncommitted tracked changes
  without the user saying yes to that specific loss.
- Leaving `node_modules` in place is fine and often wanted: it makes the next
  `pnpm worktree:setup` in that directory fast. Don't delete it just to tidy up.
- If nothing was running and nothing needs deleting, say that plainly and stop. An empty
  cleanup is a valid outcome.
