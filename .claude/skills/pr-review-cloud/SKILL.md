---
name: pr-review-cloud
description: Review a GitHub pull request as a senior engineer and report findings in the conversation as a brief overview plus a flat numbered list tagged [Blocker] / [Suggestion] / [Nit]. Use when the user runs /pr-review-cloud, names a PR number to review, or asks for a review of the current branch's PR. This is the repo's own copy, written for a Claude Code cloud session, where there is no gh CLI and GitHub is reached over MCP. It reports only: filing the findings to GitHub is submit-pr-review-cloud's job.
compatibility: Needs GitHub access and ideally a checkout of the branch. In a cloud session that access is the mcp__github__* tools; on a local checkout the gh CLI does the same jobs.
allowed-tools: Read, Glob, Grep, Bash(git:*), mcp__github
---

# pr-review-cloud

Act as a very senior engineer reviewing this pull request. Be direct and critical but
constructive. Assume production standards, and assume this code will be maintained for
years.

If `$ARGUMENTS` names a PR number or URL, review that one. Otherwise find the PR for the
current branch:

```bash
git branch --show-current
git remote get-url origin
```

```
mcp__github__list_pull_requests({ owner, repo, head: "<owner>:<branch>", state: "open" })
```

**There is no `gh` in a cloud session.** Read the PR through `mcp__github__pull_request_read`:
`get` for details, `get_diff` for the change, `get_files` for scope, `get_commits` for
history, `get_reviews` for what has already been said. This skill only reports; it posts
nothing.

If the current branch has no PR, fall back to the PR this conversation has already been
reviewing, and say which one you picked; ask only if there is none.

**Judge the PR's own code, not whatever is checked out.** The checkout may be another
branch, or behind the PR's head. Line numbers in findings are those of the head commit:
take them from `get_diff`, or read whole files at the head with
`mcp__github__get_file_contents({ owner, repo, path, ref: <head sha> })`, or fetch the head
locally (`git fetch origin pull/<n>/head:pr<n>`, then `git show pr<n>:<path>`) when git can
reach the remote. A large diff is better read in parts, or as its core files whole, than in
one dump.

**A re-review** (the PR has changed since an earlier review in this conversation) is a
review of what changed since the commit last reviewed. Check which earlier findings were
addressed, say so in the overview, and don't raise them again.

## Read the repo before judging it

There are no architecture-map tools here, so build the picture yourself, and do it before
forming opinions about consistency:

- **AGENTS.md** is the contract: the UI bar, the `Button` variant/tone vocabulary, icons
  going through `components/icons.tsx` rather than `lucide-react`, `Confirm` for every
  destructive action, the comment style, and "real notes stay out of the repo". A finding
  that cites a rule there carries far more weight than a stylistic preference.
- **docs/editor.md** and **docs/architecture.md** explain why the editor and the storage
  model are built the way they are.
  Check it before calling a design choice wrong.
- **Grep for the sibling pattern.** "This file forgot to do X" is usually best fixed by
  giving it whatever every sibling already has. Confirm the sibling exists before saying so.

## Output format

Two parts: a brief overview, then a flat numbered list. Nothing else.

### Part 1: Overview

Three to five sentences: what the PR does, whether the approach makes sense, and the overall
risk level (low / medium / high). **Do not list individual issues here**: that is Part 2.

### Part 2: Issues

One flat numbered list of every finding, grouped by severity (blockers, then suggestions,
then nits). Each item carries:

- A severity tag: **[Blocker]**, **[Suggestion]**, or **[Nit]**
- A one-line title
- The file and approximate line(s)
- A brief explanation, two to four sentences
- A concrete fix where one helps. When the fix is a direct code replacement, show the exact
  replacement so it can become a GitHub suggested change later.

```
1. **[Blocker]** Note list reads past the user's own store -- `apps/api/src/routes/notes.ts:48-57`
   The handler queries `env.DB` for notes rather than going through `reposFor`...

2. **[Suggestion]** Use the shared Button component -- `apps/web/src/components/Foo.tsx:47-55`
   This styles a `<button>` as a link, which AGENTS.md calls out specifically...

3. **[Nit]** Unused type export -- `apps/web/src/routes/index.tsx:34`
   `FooSearch` is exported but never imported anywhere...
```

## Review checklist

Guides the analysis; do **not** structure the output around it. Fold findings into the flat
list.

- **Architecture**: follows AGENTS.md? reuses existing patterns, or invents one where a
  sibling already solves it? duplicated functionality? logic in the right layer (route vs
  repo vs shared package vs component)?
- **Tenant isolation**: the sharpest rule in this codebase. A user's notes live in their
  own Durable Object (`UserStore`), reached through `reposFor` in `lib/repos.ts`; D1 holds
  only the control plane. A route that reads or writes note data any other way (`env.DB`
  for notes, or R2 bytes by a key the user's store did not hand it) is a blocker, not a
  nit. AGENTS.md's "The per-account note store" has the rules the store keeps, and
  `apps/api/test/isolation.test.ts` is the standing assertion and should grow with any
  route that touches user data.
- **React**: component sizing, state colocation, prop drilling, memoization, re-renders,
  effects, derived state, closures.
- **UX and a11y**: ARIA, labels, keyboard nav, focus management, loading/error/empty states,
  consistency with existing UI patterns. **Both breakpoints and both themes**: phone layout
  and dark mode are real targets here, and long unbounded content (an email address, a
  filename, a tag list) has broken this layout before.
- **Correctness**: bugs, edge cases, null/undefined, async, error boundaries, migrations
  that touch existing rows.
- **Performance**: the real corpus is ~13K notes and ~3GB, mostly PDFs. Assumptions that
  hold at 90 notes and fail at 13,000 are findings. Watch for anything buffering a whole
  result set in a Worker's 128MB. Rows read are a metered budget (AGENTS.md, "Rows read are
  still the budget"): a new store query belongs in the rows-read test, and each RPC to the
  store is a billable request.
- **Security**: unsafe rendering, input validation, auth, data exposure.
- **Code quality**: naming, readability, DRY, dead code, unnecessary abstraction. Comments
  that record *why*, per AGENTS.md.

## Avoid redundant findings

Before finalizing, read the branch's history
(`mcp__github__pull_request_read({ method: "get_commits" })`, or `git log <base>..HEAD`
locally) and the existing reviews (`method: "get_reviews"`). PRs go through rounds, and an
earlier commit may have already fixed a thing, or tried it and reverted it deliberately. If
the history shows a finding was handled, drop it rather than asking for it again.

Prioritize architectural consistency, correctness and long-term maintainability over minor
stylistic points.
