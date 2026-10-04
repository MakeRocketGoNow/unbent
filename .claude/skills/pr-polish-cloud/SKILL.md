---
name: pr-polish-cloud
description: Take a branch through review-and-fix rounds until it has no blockers — an independent reviewer subagent finds issues, this session fixes them in atomic commits, and the loop stops at the first round with no blockers or after three. By default it runs on the current branch and needs no PR (the usual case, before one is opened); passed a PR number or URL, it checks out that PR's branch and polishes it, pushing the fixes. Use when the user runs /pr-polish-cloud, or asks to "polish the PR", "polish this branch", "review and fix until clean", "run the review loop", to get their own change ready for review or merge, or to review and fix a PR an agent opened (a Cursor PR, say). This is the repo's own copy, written so it also works in a Claude Code cloud session, where there is no gh CLI and the branch is assigned; prefer it over a personal pr-polish skill of the same shape when running in the cloud. Do not use for someone else's PR where the findings belong to its author (that is pr-review-cloud + submit-pr-review-cloud) or to answer review threads a person or bot already left (that is fix-pr-feedback-cloud).
argument-hint: "[pr-number-or-url]"
compatibility: Needs a checkout of the branch and the pr-reviewer-cloud agent (.claude/agents/pr-reviewer-cloud.md). Works in a Claude Code cloud session and on a local checkout; GitHub is the mcp__github__* tools in the first and the gh CLI in the second. Commits, and pushes only when the branch already has an open PR.
allowed-tools: Agent, Read, Edit, Write, Glob, Grep, Bash(git:*), Bash(gh:*), Bash(pnpm:*), Bash(node:*), Bash(npx:*), mcp__github
---

# pr-polish-cloud

Review, fix, review again — the loop that used to be `pr-review-cloud`,
`submit-pr-review-cloud` and `fix-pr-feedback-cloud` run by hand two or three times on
every moderate or large change. Three things are different from running those in a row,
each on purpose:

- **The reviewer is a separate agent** (`pr-reviewer-cloud`: Opus, medium effort, the
  `pr-review-cloud` skill preloaded). The session that wrote the code reviews it badly — it remembers why
  each line is the way it is — and a full diff does not belong in this context either.
- **Nothing is posted to GitHub.** Posting each finding as a thread, fetching it back,
  replying and resolving is a conversation with yourself, and a summary comment only
  repeats what the commits say. The record of what was fixed is the fix commits, one per
  finding, each with a message that says what was wrong. What a commit cannot carry —
  what was declined, what needs the user — is said in the conversation.
- **Round one is wide.** By hand, later rounds mostly caught what the first one missed,
  not what the fixes broke. So the first round uses two reviewers with different lenses
  on anything sizeable, three on a large change, and later rounds are cheap and
  incremental.

## 0. What is being reviewed

GitHub is reached differently in the two places this runs, and nothing else below forks
on it:

```bash
[ -n "$CLAUDE_CODE_REMOTE" ] && echo cloud || echo local
```

**Cloud:** there is no `gh`; use `mcp__github__list_pull_requests` and
`mcp__github__pull_request_read`. **Local:** `gh pr view`. The examples below are written
with `gh`.

Two ways in, decided by `$ARGUMENTS`:

- **No argument — the current branch.** The default, and it needs no PR: the loop runs on
  the branch as committed here, and the PR is opened afterwards, already clean. One cheap
  look — `gh pr view --json number,headRefOid`, or `list_pull_requests` with `head:
  "<owner>:<branch>"` — only to learn whether the branch already has an open PR, because
  that decides whether fixes are pushed (step 2). No PR is not an error.
- **A PR number or URL — that PR.** Usually one an agent opened that the user wants made
  mergeable rather than commented on. Read its head branch, base branch, head SHA and
  whether it comes from a fork (`gh pr view <n> --json
  number,url,headRefName,baseRefName,headRefOid,isCrossRepository`), then get its branch
  into a checkout, since fixes are committed to it:
  - Already on its head branch: use this checkout.
  - **Cloud**, and it is not the branch this session was assigned: stop and say so. A
    cloud session pushes to its own branch and no other, so it cannot fix that PR.
  - **Local**: do not switch branches under work in progress. Add a worktree for the
    branch (`git fetch origin <headRefName>`, then `git worktree add <path> -B
    <headRefName> origin/<headRefName>`), run `pnpm worktree:setup` in it as AGENTS.md
    says, and work there.
  - A PR from a fork cannot be pushed to: stop and say so — that is a review to file with
    `pr-review-cloud` + `submit-pr-review-cloud`, not one to fix.

Then, either way:

1. **The base.** The PR's `baseRefName`, or the repo's default branch. `git fetch origin`
   and use `origin/<base>` — a local base is stale as often as not.
2. **Everything to review must be committed.** The reviewer reads a commit, not the
   working tree. Commit this session's work first (in the repo's style), or stop if the
   tree holds changes that are not this session's.
3. **With a PR, local and remote must agree**: `HEAD` equal to its `headRefOid`. Push
   unpushed commits first; pull if the remote is ahead.

The reviewer is always pointed at a base and a head SHA (`git rev-parse HEAD`), plus the
PR number when there is one.

## 1. Round one: the wide review

Size it: `git diff --shortstat origin/<base>...HEAD`.

- **Small** (under about 400 changed lines *and* under 8 files): one `pr-reviewer-cloud`,
  no lens.
- **Anything larger**: two `pr-reviewer-cloud` agents **in one message, so they run in parallel**,
  one lens each:
  - **Behaviour** — correctness, edge cases, async and ordering, error paths, tenant
    isolation and data integrity, security, rows read and performance at the archive's
    real scale, and whether the tests cover what changed.
  - **Fit** — AGENTS.md held line by line, existing patterns reused rather than
    reinvented, duplication, the right layer, the UI bar at both breakpoints and in both
    themes, accessibility, comments and naming, and nothing from a real note in anything
    that gets pushed.
- **Large** (over about 1,000 changed lines, or a change that adds a subsystem — a new
  store, index, cache, queue or background job, whatever its size): the same two, plus a
  third in the same message:
  - **Lifecycle and scale** — what the change costs and how it behaves over time, as
    opposed to whether a line is right. What now sits on the startup path, and what
    waits on it. What teardown waits for (sign-out, closing the library, an account
    switch), and whether each long step can be interrupted. What is computed once and
    shown for a while, and what refreshes it when the thing it was computed from moves.
    What each keystroke, each row and each page costs at the archive's real size, in
    rows read on the server and in work on a phone.

  When this lens runs, the Behaviour reviewer's prompt drops "rows read and performance
  at the archive's real scale": that lens already carries seven concerns, and on a long
  diff performance and lifecycle were what it ran out of attention for (MAK-142: a
  2,000-line change where both lenses missed an index opened on the library's startup
  path, an answer that never refreshed, and a per-keystroke read of every match).

The prompt for each is short, because the agent already carries its instructions: the base
ref, the head SHA, the PR number if any, `round 1`, and the lens. Do not describe the
change, explain your approach, or say what you expect it to find — that is the anchoring
the separate agent exists to avoid. Run them with `run_in_background: false`; nothing
useful happens until they return.

Merge the lists into one: drop duplicates, keep the higher severity where they
disagree, renumber. Show the merged list in the conversation before fixing, so the user
can follow along — but do not wait for a go-ahead.

## 2. Fix

For each **[Blocker]** and **[Suggestion]**, in order:

1. **Verify it.** Read the code it cites. A reviewer is wrong sometimes, and a fix for a
   problem that is not there is a new problem.
2. **Fix it, or decline it.** Decline when the finding is mistaken, already handled, or
   the wrong trade-off — and keep the one-line reason. A declined finding is not argued
   with here; it goes to the user at the end. If a finding needs a decision that is the
   user's (a product or UX call with a real trade-off), do not guess: mark it **needs
   you** and move on.
3. **Commit it on its own**, one commit per finding, in AGENTS.md's commit style. The
   message is the only record of this
   finding, so it says what was wrong and why the fix is the right one — written as a
   change to the code, not as "address review feedback". Stage explicit paths. No
   amending, no force-push, no `--no-verify`.

**[Nit]s are not fixed.** They are listed at the end. A nit that is a one-token fix inside
a line a blocker's commit already rewrites can ride along; nothing else.

Then **run the checks AGENTS.md names under Verifying**, for every part the fixes touched
— `apps/android` and `apps/ios` are outside the workspace and have their own — and fix
what they break in a separate commit. A fix that changes what the UI looks like is
verified in the browser like any other UI change.

**Push only if the branch already has an open PR**, and only when green. Before a PR
exists, the commits stay local: AGENTS.md keeps pushing on request, and whatever called
this skill (`fix-linear-issue-cloud`, or the user) decides when that is.

## 3. Decide whether to go again

Stop rule, checked after every review:

| The round found | Then |
| --- | --- |
| No blockers, small fixes | Fix its suggestions (step 2), and **finish**. No re-review. |
| No blockers, large fixes | Fix, and run one more round on the fix diff — unless this was round 3. |
| Blockers | Fix (step 2), and run another round — unless this was round 3. |
| Round 3 | Fix what can be fixed, and **finish**, with any blocker still open said first and a large unreviewed fix diff said plainly. |

"Large" is measured on the fixes, not counted on the findings: `git diff --shortstat
<sha the round reviewed> HEAD` over about 150 changed lines. Ten suggestions that are each
a rename leave nothing worth a second read; three that each rework a function leave a diff
nobody has reviewed, and that diff is the risk — the number of suggestions only guesses at
it.

Suggestions never earn another round by being found: a reviewer always finds something,
and a loop that waits for silence runs to its cap every time. Three rounds is the cap, not
the target — most changes should finish in one or two.

## 4. Later rounds: narrow

One `pr-reviewer-cloud`, no lens. Its prompt carries: the base, the new head SHA, the round
number, the SHA the last round reviewed, and the earlier findings as a list — each one's
title, severity, and outcome (`fixed in <sha>`, or `declined: <reason>`). The outcomes,
not the reasoning behind the fixes. The agent reviews the diff since that SHA and reads
the touched files whole. Then back to step 2.

## 5. Finish: tell the user

Nothing is posted. Report in the conversation, in this order:

1. Anything marked **needs you**, and any blocker still open — first and plainly,
   especially if the loop hit its cap.
2. What was declined, each with its reason.
3. The nits, each with `path:line`, for the user to take or leave.
4. What was fixed: a count per round and the commits (`git log --oneline <first reviewed
   sha>..HEAD`).
5. Where the branch stands: pushed to the PR, or local and ready for one.

## Notes

- **A bot or a person already left threads on the PR?** Those are
  `fix-pr-feedback-cloud`'s — it answers and resolves each one. This skill neither reads
  nor resolves them; say so if the PR has unresolved ones.
- **The reviewer could not run** (the agent type is missing, or it returned nothing
  usable): stop and say so. Do not fall back to reviewing in this session — the
  independence is the point.
- **Do not raise the reviewer's effort or swap its model per run.** Both live in the
  agent's frontmatter, and that is where to change them: a reviewer that differs from run
  to run makes the rounds impossible to compare.
