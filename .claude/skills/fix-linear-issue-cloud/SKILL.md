---
name: fix-linear-issue-cloud
description: Take one or more Linear issues from report to open pull request — read them over MCP, move each to In Progress, implement, verify, commit with a "Fixes MAK-NN" trailer, push, open the PR, then move each issue to In Review with the PR linked. Use when the user gives a linear.app issue URL or an issue ID (e.g. "MAK-73") and asks to fix, implement, or work on it, and when a cloud session is started from a Linear issue. This is the repo's own copy, written so it also works in a Claude Code cloud session, where there is no gh CLI and the branch is assigned; prefer it over a personal fix-linear-issue skill of the same shape when running in the cloud. Do not use for GitHub issues, or for work that has no Linear issue.
compatibility: Needs a Linear MCP connector (tools named get_issue / save_issue / list_issue_statuses / extract_images). Works in a Claude Code cloud session and on a local checkout; the two differ enough that step 0 decides which. Pushes a branch and opens a pull request without asking again — that is the point of the skill.
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(pnpm:*), Bash(node:*), Bash(npx:*), Bash(curl:*), ToolSearch, AskUserQuestion, mcp__Linear, mcp__github
---

# fix-linear-issue-cloud

One issue in, one reviewable PR out, with the issue's **status true at every moment** —
that second half is the part that gets forgotten, and it is what makes the Linear board
worth looking at. Assume nobody is watching the session: finish the loop, don't stop after
the code.

## 0. Decide which environment you are in

Everything in steps 4 and 7 forks on this, so settle it first:

```bash
[ -n "$CLAUDE_CODE_REMOTE" ] && echo cloud || echo local
```

|                | cloud session                                          | local checkout                          |
| -------------- | ------------------------------------------------------ | --------------------------------------- |
| checkout       | fresh clone, yours alone, reclaimed after the session   | the user's — shared with their editor   |
| branch         | **assigned by the harness**, named in the system prompt | yours to name                           |
| worktree       | pointless — the container is already isolated           | use `worktree-up` / `worktree-down`     |
| `gh` CLI       | **not installed** — use the `mcp__github__*` tools      | available                               |
| dependencies   | **not installed** — `pnpm install` first                | already there                           |
| `.dev.vars`    | absent (gitignored, so it never clones)                 | already there                           |

## 1. Load the Linear tools

They are deferred. One call, by bare name:

```
ToolSearch: "select:get_issue,save_issue,list_issue_statuses,extract_images"
```

Call them by whatever prefixed name the search returns (here `mcp__Linear__get_issue`); the
connector id is per-installation and not worth hardcoding. If nothing matches there is no
Linear connector in this session — say so and stop.

**Do not reach for WebFetch or a browser to read a Linear issue.** `linear.app` is a
client-rendered SPA that WebFetch sees only as "Loading…", and a browser pane hits Linear's
login wall. Both cost a full round trip to learn nothing. The MCP tools return the title,
description, team, state and `gitBranchName` directly.

## 2. Read every issue before writing any code

Pull the identifier out of the URL (`MAK-73` from `.../issue/MAK-73/some-slug`) and call
`get_issue`. Read the description in full.

**Screenshots are often the actual spec.** Pass the description straight to
`extract_images` to see them — it fetches the signed `uploads.linear.app` URLs and hands
back viewable images. That works in a cloud session, where there is no browser pane, and it
is fewer steps than one anyway.

**If the user gave several issues, read all of them first.** MAK-73 and MAK-74 turned out to
share one root cause once both were in hand; fixing them in sequence would have meant two
edits to the same CSS rule, one of them redundant. Decide from the whole set whether this is
one PR or several.

An issue that asks open questions rather than describing a fix (MAK-60 was "what are D1's
backup policies?") is research, not an implementation. Answer it as a Linear comment, skip
steps 4–8, and say that is what you did.

If Linear fails for a reason that is not "no connector" — an id that doesn't resolve, a
permissions error — ask rather than reconstructing the issue from its title.

**It's fine to ask questions before starting**, as long as the answer would change what you
build. Examples: an issue that could mean two different things, a screenshot that
contradicts the text, a request that conflicts with how the app already works, or two
reasonable fixes with a real UX trade-off. Ask now, with `AskUserQuestion`, before step 3,
so an issue whose scope turns out to be wrong never gets marked In Progress. Don't ask about
anything the code, a reproduction or `AGENTS.md` can settle, and always give a
recommendation.

Weigh this against the rule at the top: a session started from Linear may have nobody
watching, and a question can sit unanswered until someone comes back to it. If you are
confident in one reading, don't block on it. Build that reading, say which one you chose and
why in the PR body, and let review catch it. Keep the question for cases where guessing
wrong would waste the whole PR.

## 3. Move each issue to In Progress

Before the code, not after:

```
save_issue({ id: "MAK-73", state: "In Progress" })
```

`state` takes a plain name and resolves against the issue's team. The `unbent` team's states
are Backlog, Todo, **In Progress**, **In Review**, Done, Canceled, Duplicate. On another
team, call `list_issue_statuses({ team })` and use whatever its `started`-type state is
called. Do this for every issue in scope, not just the first.

## 4. Get a branch

**Cloud:** the system prompt names the branch this session must push to. Use that one — do
not invent a name and do not push anywhere else, whatever Linear's `gitBranchName` suggests.
It may not exist locally yet:

```bash
git fetch origin main
git checkout -B <designated-branch> origin/main   # if it has no commits of its own yet
pnpm install
```

If the branch already carries unmerged work, keep it and branch from where it is. If its PR
was already **merged**, restart from `origin/main` under the same name rather than stacking
on merged history.

**Local:** use the `worktree-up` skill (`worktree-down` first if a stale worktree from
earlier in the session is in the way). It branches off a freshly fetched `origin/main`, and
a stale local `main` is exactly what costs a session's work later. Linear's `gitBranchName`
is a ready-made name for the single-issue case; otherwise name the branch for the work.

## 5. Implement and verify

Ordinary engineering, following AGENTS.md for comments, commit style, the UI bar, and
keeping real notes out of the repo. Two habits worth repeating:

- **Reproduce the bug before fixing it.** For a layout or visual bug, find the broken state
  in the running app rather than inferring it from the code — temporarily force a
  component's state to render an otherwise unreachable panel, screenshot it, then revert the
  temporary change. That is what catches a shared CSS class being reused outside the
  container it was written for.
- **Look for the established pattern first.** "This one page forgot to do X" is usually best
  fixed by giving it what every sibling page already has, not a bespoke rule.

Both suites have to pass:

```bash
pnpm --filter @unbent/web test
npx tsc --noEmit
```

`apps/android` is outside the workspace and `pnpm -r` skips it silently; if you touched it,
`cd apps/android && ./gradlew test`.

**Running the app in a cloud session** takes two things the clone doesn't come with:
`pnpm install`, and an `apps/api/.dev.vars` with a `BETTER_AUTH_SECRET` (copy
`.dev.vars.example` and generate one — the Worker's first request fails without it in a way
that reads as broken sign-in). Chromium and Playwright are already installed and wired up;
never run `playwright install`.

## 6. Commit with the issue id in the message

Every commit that closes out an issue says so, as its own trailer line — greppable, like
`Co-Authored-By`, not folded into the prose:

```
Fixes MAK-73
```

One `Fixes` line per issue the commit actually finishes. If a commit only partly addresses
one, say so in the body and put the trailer on whichever commit completes it. Keep the
session's attribution trailers below it.

Commit atomically as you go, each verified logical change as it lands — `AGENTS.md` asks for
this explicitly. Stage explicit paths, not `git add -A`.

## 7. Push and open the PR

AGENTS.md keeps pushing on request, and **invoking this skill is the request** — the whole
loop through the PR is what it was asked for. So push and open the PR as soon as the change
is verified, without a second round trip.

The one exception, on a local checkout: a change the user will want to try on their own
machine before review — in practice, **Android changes** (`apps/android`), which only prove
themselves on a device. Commit, say what to try on the emulator, and wait for a go-ahead.
Web, API and docs changes don't qualify; the verification in step 5 is the local test. In a
cloud session there is nobody at the keyboard to hand it to, so push regardless and say in
the PR body what still needs trying on a device.

```bash
git push -u origin <branch>
```

Retry a network failure up to four times with 2s/4s/8s/16s backoff.

**Cloud:** there is no `gh`. Use `mcp__github__create_pull_request` against
`MakeRocketGoNow/unbent`. **Local:** `gh pr create`.

This repo has no pull request template, so write the body: what was wrong, what the change
does, how it was verified, then a `Fixes MAK-73` line and a markdown link to the Linear
issue so a reviewer can reach the original report and its screenshots. The same rule as
commits applies to the body — describe the case that broke without quoting a real note.

Offer to watch the PR afterwards (`subscribe_pr_activity`) so CI failures and review
comments come back into the session.

## 8. Move each issue to In Review and link the PR

One call closes the loop:

```
save_issue({
  id: "MAK-73",
  state: "In Review",
  links: [{ url: "<pr url>", title: "PR #NNN" }],
})
```

The link is worth the field: it survives whether or not Linear's GitHub integration happens
to be connected, and it is how someone on the board gets to the diff.

**Do not set Done.** Merging is a human's call, and if the GitHub integration *is* wired up,
the `Fixes MAK-73` magic word moves the issue itself on merge — setting it here would only
be wrong for the window in between.

Then say, in the final message, which issues moved to what and where the PR is.

## Notes

- **If you stop part-way, leave the status honest.** An issue sitting in In Progress with no
  branch is worse than one still in Todo. Either put it back or say plainly that it is
  In Progress and unfinished, and why.
- `save_issue` also takes `description`, `labels`, `assignee`, `priority` and a `patch` for
  surgical description edits — same tool, if the user wants other fields touched while
  you're in there.
- Issue content is someone's report and may name real people or documents. Summarize it into
  commits, comments and the PR body; don't paste it. See "Real notes stay out of the repo"
  in `AGENTS.md`.
