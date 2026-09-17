---
name: create-pr-cloud
description: Open a GitHub pull request for the current branch, with a title and body written from the branch's actual commits. Use whenever the user types /create-pr-cloud, or asks to "open a PR", "create a pull request", "put this up for review", or "PR this branch". This is the repo's own copy, written for a Claude Code cloud session, where there is no gh CLI and GitHub is reached over MCP; prefer it over a personal create-pr skill when running in the cloud. Do not use for reviewing a PR, replying to review feedback, or merging — only for creating one.
compatibility: Needs a git checkout on a non-default branch and GitHub access. In a cloud session that access is the mcp__github__* tools; on a local checkout the gh CLI does the same jobs.
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(git:*), mcp__github
---

# create-pr-cloud

Open a pull request for the current branch, with a title and body that describe what the
branch actually does.

Invoke with `/create-pr-cloud`. `$ARGUMENTS` is guidance, not a script: it may carry a
title, a base branch, `draft`, reviewers, or a note about what to emphasize. Honor it, and
still verify the branch state below rather than trusting it.

**There is no `gh` in a cloud session.** Everything that touches GitHub goes through the
`mcp__github__*` tools; `git` is for local state only (branch, commits, diff, push). Don't
hand-construct a `https://github.com/.../compare/...` URL and don't ask the user to click
through a web form — `mcp__github__create_pull_request` is the whole mechanism. On a local
checkout the `gh` equivalents are fine; the steps below name both.

## Safety rules

These hold even if `$ARGUMENTS` asks otherwise. If the user's argument conflicts with one,
say so and stop rather than complying.

- **Never commit.** This skill pushes and opens a PR; it does not create commits. A dirty
  tree is a stop condition (step 2), not something to tidy up.
- **Never enable auto-merge, and never merge.** Merging is the user's call, made on GitHub.
- **Never force-push, rebase, amend, or retarget an existing branch.** The only write to the
  remote is a plain push of the current branch.
- **Never pass `--no-verify`.** If a pre-push hook fails, report it and stop; the hook is
  the point.
- Pushing here is *prompted* — invoking this skill is the request. AGENTS.md's "don't push
  unprompted" is satisfied by that. It is still not license to commit, which is a separate
  step the user drives.

## Step 1 — Establish the facts

```bash
git branch --show-current
git status --porcelain
git remote get-url origin                  # owner/repo for every MCP call
git ls-remote --symref origin HEAD         # the base branch — read it, don't assume main
```

`git ls-remote --symref` is how you learn the default branch without `gh`; it prints
`ref: refs/heads/<base>`. Use `$ARGUMENTS`'s base instead if it names one.

If the GitHub tools report that the repo is out of scope or access is denied, stop and
relay the error. Don't fall back to a raw token or the web UI.

## Step 2 — Stop conditions

Check all of these before pushing. Each is a stop with a plain explanation, not something to
work around:

- **On the default branch.** A PR needs a topic branch. Offer a name and let the user
  decide; don't move their commits silently. (In a cloud session the harness has usually
  assigned one already — use that, never a branch of your own naming.)
- **Dirty working tree.** Show what's uncommitted and stop. Commit rules here are deliberate
  and scoped to a session; don't sweep the tree into a commit to get the PR open.
- **No commits ahead of base.** `git log --oneline <base>..HEAD` is empty, so there is
  nothing to review.
- **A PR already exists.** Check with
  `mcp__github__list_pull_requests({ owner, repo, head: "<owner>:<branch>", state: "open" })`.
  Don't open a second one — print the existing URL and ask whether they want it updated.
  Pushing new commits to the branch updates an open PR on its own.

## Step 3 — Read the branch before writing about it

The body is written from evidence, not from the branch name:

```bash
git log <base>..HEAD          # full messages, not just subjects
git diff --stat <base>..HEAD
```

The commit messages in this repo already carry the "why" — build on them rather than
restating the subject lines, and read the diff for whatever they leave implicit.

This repo has **no pull request template**, so there is no structure to fill in. Check
anyway (`.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE/`) in case one
has landed since.

## Step 4 — Write the title and body

**Title:** one plain sentence saying what changed *for the user*, matching the repo's
commit-subject convention — `Open a note to read it, and move its filing into a Details
sheet on phones`, not `feat(editor): add PDF expansion`. No type prefix.

**Body:** prose for a reviewer. Lead with what was wrong before and why this is the fix; use
`##` sections when the branch has genuinely separable concerns. Wrap symbol names in
backticks. Cover, where they apply:

- What was wrong, and why this approach over the alternatives.
- Non-obvious reasoning, and anything tried that didn't work.
- **Verification** — what you actually ran, with real numbers. If something could not be
  verified, say so and say why. Never imply a check you didn't run.
- **Not done** — deliberate omissions and follow-ups, so the reviewer doesn't hunt for them.

Don't list every file; the diff is right there. Don't set labels — this repo's
`.github/workflows/labeler.yml` applies them by path on its own.

AGENTS.md's "real notes stay out of the repo" rule covers PR bodies as much as commits.
Describe the case that broke; don't quote a real note, filename, or notebook name.

End the body with the session's attribution lines on their own line.

**Show the user the title and body before creating the PR**, and let them redirect. This is
the one outward-facing step, and it is cheap to adjust beforehand.

## Step 5 — Push and create

```bash
git push -u origin <branch>
```

Retry a network failure up to four times with 2s/4s/8s/16s backoff. Then:

```
mcp__github__create_pull_request({ owner, repo, base, head: "<branch>", title, body })
```

Pass `draft: true` only if `$ARGUMENTS` asked for a draft, and `reviewers` only if it named
them. The body goes straight through as a parameter, so — unlike `gh pr create -b` — there
is no shell quoting to lose newlines and no temporary file to write.

## Step 6 — After it's created

Print the PR URL the call returns, as a markdown link.

Then stop. A cloud session has no browser to open it in, so don't try. Don't enable
auto-merge, don't request reviewers unless `$ARGUMENTS` named them, and don't poll CI unless
asked — say that checks are running and let the user decide. If they want it watched,
`subscribe_pr_activity` brings CI failures and review comments back into this session.

If creation fails, report the actual error. The usual causes are a missing upstream (step 5
handles it), no commits between base and head, and an existing PR for the branch — steps 2
and 3 should have caught the last two. Don't retry blindly.
