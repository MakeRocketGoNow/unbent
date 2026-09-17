---
name: submit-pr-review-cloud
description: Submit already-identified code review findings as a formal, batched GitHub PR review — one pending review, line-specific inline comments, then a single summary submission. Use whenever a review pass has surfaced numbered findings in the conversation and the user wants them filed — "submit issues 1, 3, 5", "submit all of these findings", "post this as a review", "file the review", "send it to GitHub". Also use for leaving inline PR comments with GitHub suggested-change blocks. This is the repo's own copy, written for a Claude Code cloud session, where there is no gh CLI. Do not use for reviewing code itself — only for submitting findings that already exist.
compatibility: Needs GitHub access through the mcp__github__* tools (pull_request_review_write, add_comment_to_pending_review). A checkout of the branch helps map findings to line numbers but is not required — the PR diff can be read over MCP.
allowed-tools: Read, Glob, Grep, Bash(git:*), mcp__github
---

# submit-pr-review-cloud

Turn a set of already-identified findings into a formal GitHub review: one pending review,
batched line-specific inline comments, and a single top-level summary. The author gets one
notification instead of a flood.

**There is no `gh` in a cloud session** — every step here is an `mcp__github__*` call.

## Prerequisites

- A review has already happened in this conversation (`pr-review-cloud`, or findings the
  user pasted). This skill does not review anything itself.
- The findings are numbered, so the user can reference them.

## User input

The user may specify:

- **Which findings** — "submit issues 1, 3, 5", "all", or nothing. Given numbers, submit
  only those. Given "all", submit every one. Given nothing, use judgment: blockers and
  meaningful suggestions, skipping minor nits unless they form a pattern.
- **The verdict** — `approve`, `comment`, or `request_changes`. If unspecified, infer from
  severity: any **[Blocker]** → `REQUEST_CHANGES`; only suggestions and nits → `COMMENT`.

**Never infer `APPROVE`.** Approving is a judgment the user makes, not one to derive from an
empty findings list — if nothing is wrong, submit `COMMENT` and say the review found nothing
blocking, and let them approve it themselves.

**If the authenticated user wrote the PR, the verdict is locked to `COMMENT`**, whatever the
severity and whatever the user asks. GitHub rejects `APPROVE` and `REQUEST_CHANGES` from a
PR's own author, so there is no alternative to fall back to. Check authorship in step 1 and
skip verdict inference entirely when they match — don't ask which verdict they want, and
don't try one and retry on failure.

## Step 1 — Prepare

```bash
git branch --show-current
git remote get-url origin
```

```
mcp__github__list_pull_requests({ owner, repo, head: "<owner>:<branch>", state: "open" })
mcp__github__pull_request_read({ method: "get", owner, repo, pullNumber })   # author, base
mcp__github__get_me()                                                        # who you are
```

Compare the PR's author login against `get_me`'s. If they match, the verdict is locked per
the rule above.

Then map each selected finding to an exact path and line. `mcp__github__pull_request_read`
with `method: "get_diff"` gives the diff without needing the branch checked out; locally
`git diff <base>...HEAD` does the same. **Line numbers must be in the NEW file — the right
side of the diff.** A comment anchored to a line that isn't in the diff is rejected.

## Step 2 — Draft the summary and confirm

Draft a summary in a human, collegial tone, one to five sentences:

- Open with a `## Agent Review 🤖️` header, so it is clear an agent wrote it rather than the
  person submitting it.
- **Don't summarize what the PR changes** — the description already does.
- State the risk level (low / medium / high).
- Explain the key concern(s) and **why** they matter — user impact, correctness,
  maintainability — rather than restating the what.
- Say how many inline comments were posted.
- **Don't re-describe each finding**; the inline comments do that.
- Write like a teammate, not a linter. Acknowledge the effort, be direct about what has to
  change, and give the reasoning.

Present it to the user with the list of findings that will be posted (number and title) and
the verdict — and if the verdict is locked to `COMMENT` because they authored the PR, say
so plainly rather than presenting it as chosen from severity.

**Wait for confirmation or edits before submitting.** This is the outward-facing step.

## Step 3 — Submit

1. **Create a pending review.**

   ```
   mcp__github__pull_request_review_write({ method: "create", owner, repo, pullNumber })
   ```

   Omit `event` — that is what keeps it pending so the comments batch. If a pending review
   already exists for you, `create` fails; `method: "delete_pending"` first, then recreate.

2. **Add each inline comment.**

   ```
   mcp__github__add_comment_to_pending_review({
     owner, repo, pullNumber,
     path,                      // repo-relative
     line,                      // last line of the range
     startLine,                 // first line, for a multi-line range
     side: "RIGHT",
     subjectType: "LINE",       // or "FILE"
     body,
   })
   ```

   Each body carries the severity tag (`**[Blocker]**`, `**[Suggestion]**`, `**[Nit]**`), a
   clear description, and where a concrete fix exists, a GitHub suggestion block so the
   author can commit it in one click:

   ````
   ```suggestion
   replacement code here
   ```
   ````

   The block **replaces exactly the lines the comment is attached to** (`startLine` through
   `line`), so the range has to match precisely. If the fix is conceptual or spans too much
   to replace cleanly, use a plain fenced block instead.

   Then append a collapsed hand-off prompt, two to four sentences, referencing files by path
   so they can be `@`-tagged:

   ```
   <details>
   <summary>Paste into your Agent to fix</summary>

   In `apps/web/src/components/Foo.tsx` around lines 48-57, ... Match the pattern in
   `apps/web/src/components/Bar.tsx`.

   </details>
   ```

   End every body with the Claude Code attribution footer this environment requires on
   every GitHub post.

3. **Submit.**

   ```
   mcp__github__pull_request_review_write({
     method: "submit_pending", owner, repo, pullNumber,
     event: "REQUEST_CHANGES" | "COMMENT" | "APPROVE",
     body: <the confirmed summary>,
   })
   ```

## Notes

- Everything batches into one submission — one notification for the author, not many.
- The `body` on `submit_pending` is the top-level summary. It should not repeat the inline
  comments.
- AGENTS.md's "real notes stay out of the repo" applies to review comments too. Describe the
  case; don't quote a real note, filename, or notebook name.
- Report the review URL back as a markdown link so it is clickable.
