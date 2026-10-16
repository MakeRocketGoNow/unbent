---
name: worktree-up
description: Create a branch worktree off a freshly synced main, install and seed it, and start both dev servers on the worktree's own ports. Use when starting branch work in this repo, when the user says "start the dev server", "set up a worktree", "get the app running locally", or when a session needs a running Unbent instance with notes in it. Do not use to tear one down: that is worktree-down.
compatibility: Needs a local git checkout of unbent with an `origin` remote, pnpm, and node. Starts long-running processes.
allowed-tools: Read, Glob, Grep, Bash(git:*), Bash(pnpm:*), Bash(node:*), Bash(curl:*), Bash(lsof:*), Bash(ps:*)
---

# worktree-up

Get a branch worktree from nothing to a running, signed-in-able Unbent with sample notes.

Run the steps in order. Each one has a verification: do it, and read the result, rather
than assuming the step worked. Most of the failures this skill exists to prevent are silent.

## 1. Branch off a synced `main`

**Never branch from the local `main`.** It is stale as often as not, and a branch cut from
it starts behind, which surfaces later as conflicts, or as measurements and review taken
against code that already moved on `origin`. This has actually happened here and cost a
whole session's work.

```bash
git fetch origin
git worktree add -b <branch> .claude/worktrees/<name> origin/main
```

Branch from `origin/main`, the remote ref, not `main`, not `HEAD`. If the user points you
at an existing worktree instead, check it before trusting it:

```bash
git fetch origin && git rev-list --left-right --count HEAD...origin/main
```

Anything other than `behind: 0` means the worktree is stale. Say so and ask before
continuing: the answer is usually to start a fresh one, not to work in it.

`.claude/worktrees/` is gitignored, which is why worktrees live there.

## 2. Set up the worktree

```bash
pnpm worktree:setup --fresh  # default; omit --fresh only when asked for the real corpus
```

If this session *started* in the worktree, the `SessionStart` hook
(`scripts/worktree-autosetup.sh`) has already run this and its output (the migration table
and the ports line) is in your context. Check for it before running setup again; a second
run is harmless but slow. A worktree you created during the session gets no hook, so run it.

`git worktree add` brings tracked files and nothing else, so until this runs the worktree
has no `.dev.vars` (the Worker starts with no `BETTER_AUTH_SECRET`), no dependencies, and
no local database. The script copies the gitignored files across, installs, seeds D1 and R2
from the main checkout, applies migrations, and prints the ports. It is idempotent.

**Which variant:**

- **`--fresh` is the default.** It skips the copy and builds an empty schema from
  migrations. Right for UI and layout work, and anything where you only need *some* notes
  rather than *their* notes, which, with step 4, is almost everything. Use it unless the
  user has said they want their real notes.
- **Omitting `--fresh`** copies the main checkout's D1 *and* R2. R2 can be ~110M and the D1
  carries the user's real local notes. The upside is the browser arrives already signed
  in: the localhost session cookie is host-only and ports do not scope cookies.

**Don't copy the real corpus unless asked.** It is a decision about the user's disk and
their data, not a detail, so it takes an explicit instruction rather than a judgement call:
run `--fresh` and move on.

Verify the schema landed: a table count and a migration list, not just a zero exit code.

## 3. Start both halves

```bash
pnpm dev
```

This runs Vite *and* the Worker on the worktree's own port pair. Do not start only
`dev:web`: every `/api` call 502s and the app renders a signed-out splash with no notes,
which reads as "the dev server is broken."

**The printed line is the truth about ports.** `pnpm dev` prints them on its first line;
`node scripts/ports.mjs` answers without starting anything. The pair is derived from the
worktree name, but the bands belong to the whole machine: when something else holds a
port, `pnpm dev` steps to the next free pair and says `(its usual pair was taken)`. Never
assume 5173/8787: those are the *main checkout's*, and are usually the user's own server.

Check before starting, and if the user's server is already up, use it:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:<web>/
```

Verify both halves before moving on:

- web port returns `200`
- API port returns `404` at `/`: **this is correct**, not a failure. The Worker serves
  `/api/*` and has no root route.
- the log shows real traffic: `GET /api/config 200`, `GET /api/auth/get-session 200`

## 4. Seed sample notes

```bash
pnpm seed:demo
```

Creates `demo@example.com` / `demo-password-1234` and loads `packages/seed/`: about four
hundred invented notes: the ten presentable ones, notebooks with every custom field type,
receipts with searchable PDF and image scans, layout edge cases, a few in the trash.
Idempotent: re-running updates rather than duplicates; `--reset` clears the account's
notes first, `--small` loads only the ten.

**It needs the server from step 3 already running**: it signs up over HTTP against the
running instance. It refuses any host that is not loopback. Sign-up works because
`pnpm dev` passes `ALLOW_TEST_CREDENTIALS=1`; see `passwordEnabled` in
`apps/api/src/auth.ts`.

`EMAIL`/`PASSWORD`/`NAME` are module constants with no CLI override: only `--url`,
`--reset` and `--small` are options. **Seeding a different address means editing the script or driving
the auth endpoints by hand; don't do either with the user's real email address without
asking.** A local account under a real address buys nothing a demo account doesn't, and it
dies with the worktree's D1 anyway.

Verify by fetching notes rather than trusting the script's output:

```bash
curl -s -c /tmp/cj -X POST http://localhost:<web>/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"demo-password-1234"}' -o /dev/null -w '%{http_code}\n'
curl -s -b /tmp/cj "http://localhost:<web>/api/notes?limit=3"
```

## 5. Hand it over

Tell the user the web URL, the API URL, and the demo credentials. If they want to look at
the signed-in app, **let them sign in**: don't type credentials into the form yourself.
You don't need an authenticated browser session to measure CSS or computed styles.

## Notes

- **Report what the verification actually said.** If a step failed, say so with the output.
  Don't report success from a zero exit code you didn't read.
- Background the dev server so the session can keep working, and leave it up while the work
  is open to review. The repo's rule is that **nothing runs that the user has not been told
  about**: end every response with one line saying it is running and where, for as long as
  it is. `worktree-down` stops it, when the user is done or asks.
- The preview tool resolves its project root when the session *starts*. If this session did
  not start in the worktree, `preview_start` reads the main checkout's `launch.json` and
  reports a conflict that has nothing to do with your branch. Drive the printed URL
  directly instead; there is nothing to fix in the repo.
- Commit atomically as you go once work begins, staging only what the session touched.
  Pushing stays on request. See AGENTS.md.
