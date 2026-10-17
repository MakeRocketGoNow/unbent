# Dependencies held back on purpose

Most dependencies here take whatever is current. The ones below don't, and each says why,
what would release it, and what to run when it moves. Read this before an update round,
and add to it whenever a version is chosen for a reason the manifest cannot say: a
`package.json` has no comments, and a pin with no reason written down gets "fixed" by the
next person or bot to see it.

Dependabot's version updates are off for this reason (`.github/dependabot.yml`). It merged
wa-sqlite 2 under an adapter that peers on 1 (#336), because nothing in the manifest said
not to. Security updates still open. The one exception is the workflows' actions, whose
SHA pins Dependabot keeps fresh (below).

## Doing an update round

The `update-dependencies` skill (`.claude/skills/`) runs the whole round; this is its short form.

```bash
pnpm outdated -r
```

Take everything that isn't held below, in one commit for the plain minors and patches and
one per family or major that needs reading. Then run what CI runs: `pnpm typecheck`,
`pnpm --filter @unbent/api test:unit`, `pnpm --filter @unbent/seed test`, `pnpm build`,
`pnpm --filter @unbent/web test`, `pnpm --filter @unbent/store-tests test`, and
`pnpm gate:offline` for anything the local library, the outbox or the service worker sits
on. A major gets its changelog read, not just its tests run.

## The local library: TanStack DB and wa-sqlite

**`@tanstack/db` 0.11.1 and `@tanstack/offline-transactions` 1.0.59, exactly.** The outbox
reads two private fields: a collection's `_state.syncedData` (`syncedRow` in
`store/actions.ts`, `feedControls` in `store/collections.ts`) and the IndexedDB adapter's
`db`. `store/pins.test.ts` fails the day an upgrade moves either, and fails if the manifest
loses the exact pin.

**`@tanstack/react-db` and `@tanstack/browser-db-sqlite-persistence` move with them.** Each
depends on one exact `@tanstack/db`, so moving any one of the four alone puts two copies of
it in the graph. Pick the versions that agree: 0.11.1 is react-db 0.5.1, persistence-core
0.4.1 (browser persistence 0.2.26), offline-transactions 1.0.59.

**Not 0.12.** 0.12.0 removes `begin({ immediate })` from the sync API and queues sync
writes behind any mutation in flight. `feedControls` begins every transaction immediate
because, without it, a page of the feed waited on the outbox entry that was itself waiting
for that page: a second queued write stuck until a reload (2026-10-08). Moving to 0.12
means redesigning that, not bumping a version.

**0.11.2 and 0.11.3 are not free either.** They are patches by number but rewrite how
rows and updates are held internally (rows reused rather than copied, local-only
collections skipping the optimistic stage) which is the layer the private fields above
belong to. Take them in a change of their own, with `pnpm gate:offline`.

**`@journeyapps/wa-sqlite` ^1.** The persistence adapter peers on `^1.4.1` (as of 0.2.32,
2026-10). 2.0 updates PowerSync's own SQLite extension and their write-ahead VFS, neither
of which is used here. Released when the adapter's peer range takes 2; Dependabot ignores
the major until then.

## The service worker: vite-plugin-pwa and Workbox

**`vite-plugin-pwa` and every `workbox-*`, exactly, at the same Workbox version.** The
plugin writes the precache list with its own `workbox-build`; the worker imports Workbox's
runtime modules directly. Both sides have to be one Workbox version, or the worker is built
from two. When the plugin moves, check which `workbox-build` it depends on and set the
runtime modules to that. vite-plugin-pwa 2.0.0 still carries Workbox 7.4.1.

## Auth: Better Auth

**The family moves in lockstep:** `better-auth`, `@better-auth/mcp`,
`@better-auth/oauth-provider` and `@better-auth/passkey`, all at one version (1.7.10). A core
a version ahead of its plugins breaks the types in `apps/api/src/auth.ts`. `passkey` is
written exactly, the others with `^`; move them all together either way.

## Tooling

**Wrangler comes from the lockfile.** It is a devDependency of `apps/api`; run it with
`pnpm exec` from there. `npx` from the root downloads a different version.

**`pnpm` 9.14.4,** from the root `packageManager`. pnpm 10 stops running dependencies'
install scripts unless they are allowed by name, and `@posthog/cli` downloads its binary in
one; move pnpm on its own.

**vitest is one major across the workspace (5).** The store tests used to be held on 4 by
`@cloudflare/vitest-plugin`, which peers on one vitest major at a time; check its peer range
before taking vitest 6.

## The workflows' actions

**Every `uses:` in `.github/workflows/` names a commit SHA, with the version beside it as
a comment.** A tag is a pointer the action's publisher can move, and a publisher whose
account is taken over can point `v7` at anything; `tj-actions/changed-files` was moved
that way in March 2025 and leaked the secrets of every workflow that trusted the tag. The
workflows here run on every push to `main` with the Play keystore, the Cloudflare deploy
token and the backup mirror's R2 and D1 credentials, so a moved tag is code running with
those. A SHA cannot be moved. The repository setting `sha_pinning_required` refuses a
workflow that names a tag, so a bare `@v7` fails before it runs.

A SHA stays where it is until something proposes a new one, so this is the one ecosystem
where Dependabot's version updates are on (`.github/dependabot.yml`, limit 1): its Actions
updater opens one grouped pull request a month that moves each SHA to the commit its tag
points at now and rewrites the `# vX.Y.Z` comment beside it. The by-hand round only has to
merge it, once CI on it is green; a major in it gets its release notes read like any other.

Pinning one by hand (a new action, or a bump that cannot wait for the month) resolves the
tag through the API rather than copying a SHA from a release page, dereferences an
annotated tag to its commit, and checks the commit is in the action's own repository:

```bash
gh api repos/actions/checkout/git/ref/tags/v7 --jq '.object | .type + " " + .sha'
gh api repos/actions/checkout/git/tags/<sha> --jq .object.sha   # only when the type is "tag"
gh api repos/actions/checkout/commits/<sha> --jq .sha
```

Each action has one SHA across every workflow, and the comment is the exact version the
tag resolved to (`# v7.0.1`, not `# v7`), which is the shape Dependabot keeps up. The
allowed list in the repository's Actions settings names the three actions outside
`actions/*` (`pnpm/action-setup`, `gradle/actions`, `r0adkll/upload-google-play`); a new
action from another publisher has to be added there as well as pinned, or the run is
refused.

## The apps

Android and iOS dependencies are not part of a web update round: they prove themselves only
on a device, and their builds are checked outside the pnpm workspace (`AGENTS.md`,
Verifying).

**`androidx.compose.material:material-icons-core` 1.7.8** (`libs.versions.toml`). Discontinued
by Google; 1.7.8 is the last release and the Compose BOM no longer carries it.
