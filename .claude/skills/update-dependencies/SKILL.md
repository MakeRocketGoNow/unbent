---
name: update-dependencies
description: Run a round of npm dependency updates for this workspace the way Dependabot cannot — read DEPENDENCIES.md for what is held and why, check peer ranges and changelogs rather than trusting version numbers, take what is safe in atomic commits, verify with the CI suites (and the offline gate or the browser where a package warrants it), record any new hold, and open the PR. Use when the user asks to "update dependencies", "do a dependency round", "bump packages", "what's outdated", or to take or review a Dependabot-style batch. Do not use for adding a new dependency (ask first, per AGENTS.md), for Android or iOS dependencies (they prove themselves only on a device), or for a single security fix the user has already scoped.
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(git:*), Bash(gh:*), Bash(pnpm:*), Bash(node:*), Bash(npm view:*), Bash(npx:*)
---

# update-dependencies

Dependabot's version updates are off in this repo. It merged wa-sqlite 2 under an adapter
that peers on 1 (#336), and the round after it would have moved TanStack DB to 0.12, which
removes an API the feed engine depends on. Neither was visible from a version number. This
skill is the round done with that context: [DEPENDENCIES.md](../../../DEPENDENCIES.md) is the
context, and keeping it current is half the job.

## 1. Start clean

Work in a worktree off a freshly fetched `origin/main` (AGENTS.md, Working from a git
worktree), so the user's checkout and its install are untouched. Then:

```bash
pnpm install --frozen-lockfile
pnpm outdated -r --format list
```

Read DEPENDENCIES.md in full before deciding anything.

## 2. Sort what is outdated

Every line of `pnpm outdated` goes in exactly one of four piles:

- **Held.** Named in DEPENDENCIES.md. Check whether what releases it has happened — a peer
  range widened, an upstream fix shipped — with `npm view <pkg>@latest peerDependencies`
  or `dependencies`. If it has, it becomes a family or major below and the hold comes out
  of the doc in the same commit. If not, leave it and say so in the PR.
- **A family.** Packages that must move together: anything depending on an *exact* version
  of a sibling (`npm view <pkg>@<v> dependencies` — the TanStack DB set is four packages
  on one exact `@tanstack/db`), the Better Auth set, vite-plugin-pwa with the `workbox-*`
  runtime modules. Find the versions that agree before installing any of them.
- **A major.** Read the changelog. A major is a commit of its own.
- **Plain minors and patches.** Everything else.

**A patch is a patch by content, not by number.** Read the changelog for anything the app
reaches into, extends, or depends on for its offline or sync behaviour, whatever the
number says: TanStack DB's 0.11.2 rewrote how rows are held while calling itself a patch.
For a monorepo package the changelog is usually `packages/<name>/CHANGELOG.md`:

```bash
gh api repos/<owner>/<repo>/contents/packages/<name>/CHANGELOG.md --jq .content | base64 -d
```

Then grep the codebase for every API the changelog says was removed or changed. A
"breaking" note about something this repo never calls is not a reason to hold.

## 3. Update in atomic commits

Name the packages. `pnpm -r update <a> <b> …` stays inside the semver ranges and leaves
exact pins exact; never `pnpm update --latest` across the workspace, which rewrites pins.
After each step, `git diff -U0 -- '*package.json'` and confirm only what you meant moved.

One commit for the plain minors and patches, one per family, one per major, one for any
change to DEPENDENCIES.md that isn't already part of those. Each commit says what moved and,
for anything that was read, why it is safe; the tree must install with
`--frozen-lockfile` and typecheck at every commit.

## 4. Verify

What CI runs, all of it, before the push, plus the ENEX parser's tests, which CI does not run
and which pdf.js and zip.js updates reach:

```bash
pnpm typecheck
pnpm --filter @unbent/api test:unit
pnpm --filter @unbent/seed test
pnpm --filter @unbent/enex test
pnpm build
pnpm --filter @unbent/web test
pnpm --filter @unbent/store-tests test
```

And by what moved:

- **The local library, the outbox, wa-sqlite, the service worker or Workbox:**
  `pnpm gate:offline`, with the worktree's `pnpm dev` up, the demo seeded and the web app
  built (AGENTS.md, Testing it). `store/pins.test.ts` failing means a private field moved:
  that is a hold, not a test to update.
- **Anything drawn:** CodeMirror, pdf.js, lucide, React. Start the worktree's dev server,
  `pnpm seed:demo`, and look at a note with a PDF in the browser: the editor mounts, the
  page renders, the icons draw, the server log is clean.
- **The Worker, Wrangler, Hono, Better Auth:** sign in on the local instance and load the
  note list; for Better Auth, a sign-in and a session refresh.

A worktree that was never set up answers every request with Better Auth's schema mismatch:
run `pnpm worktree:setup --fresh` and restart the server before blaming an update.

## 5. Write it down

Every version you held this round, and every hold you lifted, goes in DEPENDENCIES.md:
what is held, why in one or two sentences a future reader can check, what would release
it, and what to run when it moves. If a hold has a matching `ignore` in
`.github/dependabot.yml`, update that too; version updates are off, but security updates
still read it.

## 6. The pull request

Push and open the PR with `gh pr create`. The body lists what was taken, what was held and
why (linking DEPENDENCIES.md), and what was checked. Close any Dependabot PR it supersedes,
with a one-line comment saying which PR replaces it.

**Merge only when the user has said to**, and only on green CI. If GitHub reports a
conflict that `git merge origin/main` does not reproduce, merge main, push, and wait for
CI again rather than retrying the merge. After a merge, watch `main`'s "Web and API" run
through its `deploy` job, since that is production, and report the commit it deployed.

If the round turns up nothing safe to take, say so and still update DEPENDENCIES.md with
anything newly learned. A round that ends in a correct hold is a finished round.
