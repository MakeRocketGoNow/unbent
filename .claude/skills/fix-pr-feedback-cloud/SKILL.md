---
name: fix-pr-feedback-cloud
description: Verify each open PR review comment against the current tree, then fix it and/or push back on the GitHub thread, and resolve what you fixed. Use when the user runs /fix-pr-feedback-cloud, or asks to address, fix, reply to, or resolve open PR review comments, bot findings, or review threads on the current branch's PR. This is the repo's own copy, written for a Claude Code cloud session, where there is no gh CLI and GitHub is reached over MCP; prefer it over a personal fix-pr-feedback skill when running in the cloud. Do not leave a thread unanswered.
compatibility: Needs a git checkout of the PR branch and GitHub access. In a cloud session that access is the mcp__github__* tools; on a local checkout the gh CLI does the same jobs. Pushes commits to the PR branch.
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(git:*), Bash(pnpm:*), Bash(npx:*), Bash(node:*), mcp__github
---

# fix-pr-feedback-cloud

For every open thread on this PR: verify the issue is real against the current tree, then
**fix it and/or push back in the GitHub comments**. Do not leave a thread unanswered.

Invoke with `/fix-pr-feedback-cloud`. If `$ARGUMENTS` is a PR number, use that PR; otherwise
find the one for the current branch. Extra arguments are guidance (e.g. only certain
threads), not a license to skip unanswered ones.

**There is no `gh` in a cloud session** — GitHub goes through `mcp__github__*`, and `git` is
for local state only. Don't amend review-fix commits, force-push, rebase, or touch git
config. Don't pass `--no-verify` or `--no-gpg-sign`. Pushing the fixes (step 6) happens
*before* any reply, so the reply can cite a commit the reviewer can see.

## Resolve the PR

```bash
git branch --show-current
git remote get-url origin     # owner/repo for every MCP call
```

PR number: `$ARGUMENTS` if given, else
`mcp__github__list_pull_requests({ owner, repo, head: "<owner>:<branch>", state: "open" })`.

## Steps

1. **Fetch the review threads.**

   ```
   mcp__github__pull_request_read({ method: "get_review_comments", owner, repo, pullNumber })
   ```

   This returns threads, not loose comments — each carries its GraphQL node ID (`PRRT_…`),
   its resolved state, and the comments inside it with `path` and line coordinates. That is
   everything the fix *and* the resolve need, so there is no separate GraphQL query to run
   the way there is with `gh`.

   **Two different ids come back and they are not interchangeable.** The thread's `PRRT_…`
   node ID resolves a thread; the comment's numeric `id` (the number in a
   `#discussion_r…` anchor) is what a reply attaches to. Mixing them fails in a way that
   reads as a permissions error.

   Skip threads already marked resolved.

2. **Fetch the top-level review summaries too** — bot findings often live in the summary
   body rather than on a line:

   ```
   mcp__github__pull_request_read({ method: "get_reviews", owner, repo, pullNumber })
   ```

3. **Read the cited file at the cited lines and verify the problem still exists.** The
   branch may have moved since the review was posted. A finding's line coordinates can be
   stale or null on an outdated comment — find the code, don't trust the number.

4. **If the issue is real, fix it. If it is stale, wrong, or the wrong trade-off, do not
   silently skip it** — push back on the thread with a short reason. If the comment is
   ambiguous, ask a follow-up question on the thread rather than guessing.

   Match the pattern the rest of the codebase uses; don't invent a new one to satisfy a
   comment. If a finding is about a missing guard, grep for that variable in sibling files
   to confirm the expected shape first.

5. **Commit each fix separately** — one commit per reviewed finding, so it is traceable and
   individually revertable. Subjects follow AGENTS.md: a plain sentence saying what changed
   for the user, never `fix: …`. Use a heredoc for the body.

   Stage with `git add -u <path>` when a filename contains characters the shell expands
   (`$` in particular); avoid a bare `git add <path>` in that case.

   If you bundle several fixes by accident, split them — `git reset HEAD~1`, then recommit
   one at a time.

6. **Re-run the checks over the whole batch, then push.** A pile of review patches routinely
   breaks formatting, types, or an adjacent test that no single change touched:

   ```bash
   pnpm --filter @unbent/web test
   npx tsc --noEmit
   ```

   If you touched `apps/android`, also `cd apps/android && ./gradlew test` — it is outside
   the pnpm workspace and `pnpm -r` skips it silently.

   Fix anything red, commit the breakage as its own commit (never amend a review-fix
   commit), and re-run until green. **Do not push red.** Then:

   ```bash
   git push -u origin <branch>
   ```

   Do not reply or resolve until the push succeeds.

7. **Reply on every thread.** Each one gets a GitHub reply — what changed and which commit
   addresses it, a clarifying question, or a push back with a short reason.

   ```
   mcp__github__add_reply_to_pull_request_comment({
     owner, repo, pullNumber,
     commentId: <numeric comment id, not the PRRT_ thread id>,
     body,
   })
   ```

   Reply on the inline comment, not only as a top-level PR comment. Prefix the body with
   `🤖️`, and end it with the Claude Code attribution footer this environment requires on
   every GitHub post.

8. **Resolve the threads you fixed** — including ones already addressed by an earlier
   commit:

   ```
   mcp__github__resolve_review_thread({ owner, repo, threadId: "PRRT_…" })
   ```

   Leave a thread open when you asked a question or pushed back and still need the
   reviewer's answer. Resolving one of those hides the thing you are waiting on.

## Notes

- A finding from a review bot is a bug report until you have checked it — verify, then fix
  or rebut. "It's a bot" is not a reason to skip one, and neither is "design-level".
- Cross-check a finding against the rest of the codebase before accepting it; grep for the
  same pattern elsewhere to tell a real inconsistency from noise.
- Never skip, disable, or quarantine a test to make a check pass.
- If the branch is not yours — you did not open the PR and its author did not ask you to
  drive it — larger asks get a proposal on the thread, not a push.
