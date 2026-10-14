# Unbent

A personal note app that keeps your notes in Markdown and hands them back whenever you ask.

Notes are Markdown with YAML frontmatter. Attachments are ordinary files. Export produces a
plain folder tree — one directory per note, containing the note's markdown and a `files/`
subdirectory — that you can read, grep, and back up without this app existing, and import
back into any Unbent.

The Markdown is the note, not a serialization of one. A note you save is byte-identical to
what you typed: no reflowed lists, no `_italic_` quietly rewritten to `*italic*`, no escaped
underscores in a filename. That is the whole promise, and it is what makes the export
guarantee worth anything — a format the app rewrites behind your back is a format you do not
actually own.

Editing it should still feel like a word processor. See [Editing](#editing).

## Why

Evernote's owner gave a lot of people a reason to leave. Leaving should be easy, and staying
should never depend on it being hard.

## Stack

- **Cloudflare Workers** + Hono — API, and static-asset hosting for the SPA
- **TanStack Router + Query** — real routes, typed search params, cached loaders
- **Cloudflare Durable Objects** (SQLite) — one per account, holding its notes, metadata
  and FTS5 full-text search; see [Where your notes live](#where-your-notes-live)
- **Cloudflare D1** (SQLite) — accounts, sessions, OAuth clients, and the account directory
- **Cloudflare R2** — attachment blobs
- **Better Auth** — OAuth (Google, GitHub)
- **Vite + React + CodeMirror 6** — Markdown editor, styled in place (see [Editing](#editing))

One Worker serves both the built SPA and `/api`, so the two are genuinely same-origin and
the session cookie needs no CORS or `SameSite` workarounds.

The free tier is enough, including for the initial migration. Measured against a real
13,158-note Evernote account with 4,084 attachments:

| Limit | Full import | Free tier |
| --- | --- | --- |
| Worker requests | ~17,200 | 100,000/day |
| D1 rows written | ~43,400 | 100,000/day |
| R2 storage | 2.6 GB | 10 GB |

Import posts one note per request, plus one per attachment. That is deliberate rather than
unoptimized: per-note requests are what let an interrupted import resume without any
server-side progress tracking, and a re-run costs one request and *zero* D1 writes per note
that already landed, because the content-hash lookup short-circuits before any insert.

The tightest of these is D1 rows written per day, at roughly 2.3x headroom — so the thing
to avoid is importing a whole account twice in the same day. Nothing here needs Workers
Paid; take it for the higher ceilings if the instance grows, not to get started.

CPU is not a constraint at either end: ENEX parsing runs in a browser Web Worker rather
than on Workers, and the export zip is assembled in the browser from pages of notes.

## Layout

```
apps/web       Vite + React SPA
apps/api       Hono API on Workers, and the MCP server under src/mcp
apps/android   Kotlin app: the site in a WebView, with native sign-in, share sheet and files
apps/ios       Swift app: the site in a web view, with native sign-in and files
packages/shared  zod schemas, frontmatter codec, remark plugins
packages/enex    ENEX -> Markdown, runtime-agnostic
```

`apps/android` is a Gradle project, not a pnpm workspace package: `pnpm -r` skips it, and it
is built with its own wrapper. See [Android app](#android-app). `apps/ios` is an Xcode
project with two Swift packages beside it, skipped the same way. See [iOS app](#ios-app).

## Development

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # then fill in BETTER_AUTH_SECRET
pnpm migrate:local
pnpm dev
```

The SPA runs on :5173 and proxies `/api/*` to the Worker on :8787, so sessions are same-origin
and there is no CORS in development.

### Worktrees

A second checkout needs a second pair of ports, or its Vite lands on top of the first one's
Worker and every sign-in is refused as CSRF. `pnpm dev` derives the pair from the checkout
and prints it; the main checkout always keeps 5173/8787.

```bash
git worktree add ../unbent-feature feature
cd ../unbent-feature
pnpm worktree:setup
pnpm dev          # web http://localhost:5217  api http://localhost:8817
```

`worktree:setup` copies the gitignored files git cannot bring across (`.dev.vars`,
`local.properties`), installs, and seeds the worktree's local state with a copy of the main
checkout's — D1, R2 and the per-account note stores under `do/` — so the same notes are
there, and because the session cookie on localhost is host-only and ports do not scope
cookies, the browser arrives already signed in. The copy is a snapshot: the two drift apart
from then on, which is the point, since a branch's migrations must not reach the main
checkout's schema. `--fresh` starts empty instead.

A Claude Code session opened in a worktree runs `worktree:setup --fresh` on its own, once,
through the `SessionStart` hook in `.claude/settings.json` (`scripts/worktree-autosetup.sh`).
It only acts in a worktree that has no dependencies or no local database yet, never in the
main checkout, and always starts empty: copying your notes into a worktree is a choice you
make by running `pnpm worktree:setup` without `--fresh` yourself.

Social sign-in is the one thing a worktree does not get for free — Google and GitHub match
the redirect URI including its port, so a worktree's port has to be registered with the
provider to use it. A password — `pnpm dev` turns password sign-up on for every local
Worker — or the sign-in code printed to the Worker console needs nothing registered.

## Running your own instance

Unbent is one Cloudflare Worker serving the site and the API, and the top level of
`apps/api/wrangler.toml` is that Worker — the same file whether the instance is unbent.app
or yours. Nothing in the repository names a deployment: resources are named rather than
identified and the first deploy provisions them, the origin is derived from the request
when nothing configured one, and a custom domain is attached in the dashboard. So a fork
deploys the file unchanged, and pulling upstream never touches the thing that holds your
notes. The named environments below the top level are local development (`local`) and
unbent.app's own dev instance and pull-request previews (`dev`, `preview`); a fork ignores
them.

Three ways to get an instance, from least to most hands-on. Each ends at the same place,
and `pnpm setup:instance --check` reads any of them back.

### With the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MakeRocketGoNow/unbent)

Cloudflare copies the repository into your GitHub account, creates the database and the
bucket, asks for the two things every instance has to decide — an auth secret and who may
sign in, the uncommented lines of `apps/api/.dev.vars.example` — and deploys. From then on
every push to your copy deploys through Workers Builds. The copy is not a GitHub fork, so
taking upstream changes is a remote and a merge:

```bash
git remote add upstream https://github.com/MakeRocketGoNow/unbent.git
git pull upstream main
```

R2 has to be enabled on the account first; it is a dashboard toggle with terms attached, and
nothing can press it for you.

### With GitHub Actions

Fork, set three repository secrets, push to `main`:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | a token from the "Edit Cloudflare Workers" template, plus **D1:Edit** and **Workers R2 Storage:Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | from the dashboard's sidebar |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`, once |

`.github/workflows/web.yml` creates the database if the account has none, applies
migrations, and deploys the Worker with the auth secret. The third secret exists because a
Worker that does not exist yet cannot have a secret put on it, and `wrangler.toml` declares
this one required; the deploy carries it, and re-sending it on every push is harmless. The
run's log ends with the instance's `workers.dev` address.

### From your laptop

```bash
pnpm install
pnpm setup:instance
```

The script checks everything an instance needs and offers to fill each gap, in order: log in
to Cloudflare, create the database, apply migrations, build and deploy with a generated auth
secret, ask who may sign in and who runs the instance, and set the GitHub secrets above if
you want pushes to deploy. Every step says what it is about to run; `--dry-run` prints the
commands instead of running them, and `--check` reports without changing anything and exits
non-zero when something required is missing — which makes it a status page for an instance
you set up some other way:

```bash
pnpm setup:instance --check --url https://notes.example.com
```

Three things it cannot do, because they have no API, so it links to each and waits: enable
R2 on the account, mint the API token for GitHub, and own the domain.

The same steps by hand, for when a script is the wrong tool:

```bash
cd apps/api
pnpm exec wrangler login
pnpm exec wrangler d1 create unbent
pnpm migrate:remote
pnpm build
printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 32)" > /tmp/unbent-secrets
pnpm exec wrangler deploy --env "" --secrets-file /tmp/unbent-secrets && rm /tmp/unbent-secrets
pnpm exec wrangler secret put ALLOWED_EMAILS
```

After the first deploy it is `pnpm release` from the repo root. Wrangler is a devDependency
of `apps/api`, not a global install — the lockfile pins the version the config is known to
work with, and `pnpm exec` from that directory runs the pinned one; `npx` from the repo
root downloads a different version instead.

### Your own domain

Add it to the Worker in the dashboard, under Settings → Domains & Routes → Custom domain.
Cloudflare creates the record and the certificate, and a deploy with no routes in its
config leaves it alone. The instance is then reachable on two origins, the domain and the
`workers.dev` name, each a front door of its own with its own cookies and passkeys. To
close the second one, pin the first:

```bash
pnpm exec wrangler secret put APP_URL     # https://notes.example.com, no trailing slash
```

A secret rather than a var because a deploy replaces plain vars. Every other hostname then
refuses sign-in as an untrusted origin, which is what unbent.app does. With GitHub Actions,
set it as the `APP_URL` repository secret instead and the deploy carries it.

### Everything you can set

Nothing below is required except the first row. Each is a Worker secret unless the table
says otherwise; `pnpm exec wrangler secret put NAME` from `apps/api`, or the dashboard.

| Setting | For | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | signing sessions | **required**; declared so in `wrangler.toml` |
| `ALLOWED_EMAILS` | who may create an account | comma-separated; empty means anyone, and the Worker warns |
| `PUBLIC_SIGNUPS=1` | saying an empty allowlist is deliberate | silences that warning and nothing else |
| `FRONT_PAGE=1` | the front page at `/` for signed-out visitors | unbent.app's own pitch and prices, so leave it unset on yours; unset, `/` is the sign-in screen |
| `APP_URL` | pinning one origin | see [Your own domain](#your-own-domain); also a GitHub secret the deploy carries |
| `OPERATOR_NAME`, `OPERATOR_EMAIL` | the built-in privacy policy and terms | both or neither; see [Who runs this instance](#who-runs-this-instance) |
| `OPERATOR_EMAILS` | who is shown what only the people running the instance can fix | comma-separated, like `ALLOWED_EMAILS`; unset means nobody. A separate list from the pair above, which is one legal contact rather than a set of sign-ins. `DEV_OPERATOR_EMAILS` as a GitHub secret carries a list to the dev instance and previews |
| `LEGAL_PRIVACY_URL`, `LEGAL_TERMS_URL` | legal pages hosted elsewhere | both or neither; win over the built-in ones |
| `LEGAL_VERSION` | asking everyone to agree again | only with your own documents; see [Who runs this instance](#who-runs-this-instance) |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | codes by email, password reset | the first two or neither; see [Choosing sign-in methods](#choosing-sign-in-methods) |
| `<PROVIDER>_CLIENT_ID`, `<PROVIDER>_CLIENT_SECRET` | any of Better Auth's OAuth providers | both or neither; the callback is `/api/auth/callback/<provider>` on your origin |
| `AUTH_PASSWORD`, `AUTH_PASSKEY` | forcing a method on or off | rarely needed; the defaults are explained in the sign-in section |
| `POSTHOG_KEY`, `POSTHOG_HOST` | error tracking | see [Errors in the browser](#errors-in-the-browser) |
| `TYPESAFE_API_KEY` | filing a note from what it says | see [Filing a note from what it says](#filing-a-note-from-what-it-says); `DEV_TYPESAFE_API_KEY` as a GitHub secret carries a separate key to the dev instance and previews |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Auto-fill's language model: reading a note's pictures and text-less scans on a press, and writing its title and text fields | see [Reading images](#reading-images); `DEV_ANTHROPIC_API_KEY` as a GitHub secret carries a separate key to the dev instance and previews |
| `ANTHROPIC_READ_MODEL`, `ANTHROPIC_TITLE_MODEL`, `ANTHROPIC_FIELDS_MODEL`, `ANTHROPIC_READ_EFFORT` | a model per job, and the reading's effort | each unset falls back to `ANTHROPIC_MODEL`; see [Reading images](#reading-images) |
| `AUTOFILL_DAILY_CAP` | a ceiling on Auto-fill presses per account per UTC day | a whole number; unset means none. Every press and the model's tokens are counted either way, and Maintenance shows the year's; see [Filing a note from what it says](#filing-a-note-from-what-it-says) |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PLAN_PRICE_ID`, `PADDLE_STORAGE_PRICE_ID` | selling the plan through Paddle | all five or none; unset, every account is active for good and nothing about billing is drawn. unbent.app's own, so leave them unset on yours. `DEV_PADDLE_*` as GitHub secrets carry the sandbox's to the dev instance; see [Selling the plan](#selling-the-plan) |
| `ANDROID_ASSET_LINKS` | an Android build of your own | see [Android app](#android-app) |
| `APPLE_APP_SITE_ASSOCIATION` | an iOS build of your own | see [iOS app](#ios-app) |
| `APPLE_BUNDLE_ID` | Sign in with Apple from an iOS build of your own | comma-separated bundle ids, beside `APPLE_CLIENT_ID`; see [iOS app](#ios-app) |
| `SWEEP_TOKEN` | sweeping the note stores at the end of each deploy | a GitHub secret the deploy carries to the Worker, `openssl rand -hex 32`; see [Where your notes live](#where-your-notes-live). `DEV_SWEEP_TOKEN` does the same for the dev instance |
| Custom domain | serving from your own name | dashboard, not config |
| `UNBENT_BUNDLE_ID_BASE`, `UNBENT_INSTANCE_HOST`, `DEVELOPMENT_TEAM` | an iOS build of your own | `apps/ios/Config/Local.xcconfig`, untracked; see [iOS app](#ios-app) |
| `ANDROID_APPLICATION_ID`, `ANDROID_DEFAULT_INSTANCE` | the Android build in CI | GitHub repository **variables**; `unbent.applicationId` and `unbent.defaultInstance` in `local.properties` locally |
| `CLOUDFLARE_WORKERS_SUBDOMAIN`, `DEV_BETTER_AUTH_SECRET`, `DEV_ALLOWED_EMAILS` | a dev instance and PR previews of your own | GitHub; see [The dev instance](#the-dev-instance) — every job skips itself without them |
| `RESTORE_R2_ACCESS_KEY_ID`, `RESTORE_R2_SECRET_ACCESS_KEY` | putting one account's files back from the mirror | GitHub secrets in the `restore` environment, read-write on the live bucket, with the environment restricted to deployments from `main`; see [Where your notes live](#where-your-notes-live) — the run refuses without them |
| `LIVE_R2_ACCOUNT_ID`, `LIVE_R2_ACCESS_KEY_ID`, `LIVE_R2_SECRET_ACCESS_KEY`, `DUMPS_R2_ACCESS_KEY_ID`, `DUMPS_R2_SECRET_ACCESS_KEY`, `MIRROR_R2_ACCOUNT_ID`, `MIRROR_R2_ACCESS_KEY_ID`, `MIRROR_R2_SECRET_ACCESS_KEY`, `D1_EXPORT_API_TOKEN` | the nightly mirror to a second Cloudflare account | GitHub secrets, with `BACKUPS_BUCKET` as a variable; the live key read-only, the R2 keys scoped to one bucket each, the D1 token D1 Read and Edit on the account, since the export endpoint refuses Read alone and needs no bucket; see [Where your notes live](#where-your-notes-live) — the job skips itself without them |

The one thing that *would* work by accident is who the legal documents name — a fork that
deployed the file unchanged would otherwise publish somebody else's legal entity. That is why
it is configured outside the file entirely, as the next section describes.

### Who runs this instance

The privacy policy, the terms and the "how to delete your account" page name a legal entity
and give an address to write to. Four variables decide what they say, and a fresh checkout
sets none of them.

| Set | `/privacy` and `/terms` | Sign-in screen and account menu |
| --- | --- | --- |
| `OPERATOR_NAME` + `OPERATOR_EMAIL` | the built-in documents, filled in | link to them |
| `LEGAL_PRIVACY_URL` + `LEGAL_TERMS_URL` | a sentence naming where they are, and a link | link straight there |
| nothing | "this instance has not published a privacy policy" | no consent line, no menu items |

Each pair is both-or-nothing, the same convention as an OAuth credential pair: a policy that
names a company with no way to reach it is worse than one admitting there is none here. The
external URLs win over the built-in documents when both are set — an operator who published
their own is the one to believe.

Two things in the built-in documents are not configurable: they say the service is hosted in
the United States, and that Minnesota law governs the terms. Both are facts about a
jurisdiction rather than a name to substitute, and a variable holding "Minnesota" would
produce a governing-law clause nobody had read. If either is wrong for you, write your own
and point `LEGAL_PRIVACY_URL` and `LEGAL_TERMS_URL` at them.

The software is called Unbent throughout either way. That is this program's name, not the
name of whoever is answerable for running it.

Wherever there are documents to link to, a signed-in account is asked to agree to them
before the app opens: once, on a screen of its own, with both documents linked and an
"Agree and continue" press. The version agreed to and when are kept on the account. Signing
in and signing up are the same press here, so the sign-in screen only gives notice; the
agreement is the screen after it, and the Android and iOS apps reach it as the site. Someone
who does not agree can still sign out, or export their notes and delete the account. The
server holds the same line for the two ways a program gets a credential of its own —
approving an OAuth client and approving a CLI's device code — which are refused to an
account that has not agreed, however they are called. Connections that already exist keep
working.

Moving `LEGAL_VERSION` in `packages/shared/src/legal.ts` asks everyone again, worded as an
update, with `LEGAL_CHANGE` beside it to say what changed. Move it for a change worth
interrupting people for, not for every correction: the documents' effective dates move for
those on their own. An operator with their own documents sets `LEGAL_VERSION` in the
environment instead, since only they know when those change; unset, everyone is asked once,
and a change to the built-in documents never asks them again.

Set them per deployment rather than in `wrangler.toml`, which everyone who self-hosts
checks out:

```bash
cd apps/api
pnpm exec wrangler secret put OPERATOR_NAME
pnpm exec wrangler secret put OPERATOR_EMAIL
```

Neither value is confidential — both are printed on a public page — so a plain environment
variable in the Cloudflare dashboard does just as well. What matters is only that they stay
out of the file a fork inherits.

### Page statistics

Cloudflare Web Analytics, which is free, sets no cookie and assigns no identifier — the
reason the privacy policy can describe it as aggregate and anonymous and still promise
nothing follows you between sites.

There is nothing in this repo to configure it. Cloudflare injects the beacon itself, from
Web Analytics in the dashboard, under the site's Real User Measurements setting.

That is deliberate rather than the path of least resistance. Injecting it ourselves — a
build-time token, a Vite plugin, a GitHub secret — was written and then thrown away, because
the dashboard offers **Enable, excluding visitor data in the EU**, which skips the beacon
entirely for visitors from the EU. A tag in our own `index.html` cannot do that; it would
load for everyone and leave us arguing that cookieless analytics needs no consent. Not
collecting it at all is the better answer, and it costs a setting rather than code.

The trade is that European visitors are missing from the numbers, and that the setting lives
in the dashboard where nothing here can see it — a beacon that stops appearing is a change
somebody made there, not a regression to look for in a build. Both are worth it for having
no token to lose.

Content blockers stop the beacon too, so treat all of this as "which pages get used" rather
than as a count of anybody.

### Errors in the browser

A thrown exception in the page POSTs itself to `/api/client-errors`, which logs one line
into the Worker's own logs — `wrangler tail` live, or Workers Logs in the dashboard, where
it is searchable for three days on the free plan.

It exists because of the Android app. The app is this site in a WebView, so a
JavaScript failure is invisible to Play's crash reporting: the process never dies, and to
Android nothing happened. The logged `userAgent` is what separates "broken everywhere" from
"broken only in the app", which is the first question these reports raise.

Nothing about it needs configuring, and there is no note content in a report: the route is
logged with note ids replaced, and the query string is dropped. See
`apps/web/src/report-error.ts`.

#### Grouping them, optionally

Three days and no aggregation is thin, which was said here when the endpoint was written:
Crashlytics or Sentry would do it better, and the reason for neither was that it would put
another company in the privacy policy of every instance for something the logs already
cover. The signal to reconsider was the missing grouping costing real time, and it did.

What changed is not the judgement but who pays for it. `POSTHOG_KEY` adds PostHog as a
second destination on the instance that sets it, and on no other: the SDK is imported
dynamically, so an instance without a key never downloads it, and the privacy policy is
built from the same config, so its policy does not mention a service it never contacts. The
first-party log stays unconditional either way — it is the one destination that works with
nothing configured, and an error thrown before anything else has loaded is already in it.

Errors only. Page views stay with the hosting provider above, which sets no cookie and
assigns no identifier; moving them here would trade that for a worse answer. Every capture
path is off in `init` and off again in `before_send`, so a default that changes in some
future version cannot quietly turn this into a tracker. No session recording in particular:
a recording of this app is a recording of somebody's notes.

```bash
cd apps/api
pnpm exec wrangler secret put POSTHOG_KEY
```

The token is public and write-only — it ships in the page — and is a secret here only to
keep one fewer credential in a repository people fork. `POSTHOG_HOST` sets the region;
unset means PostHog's US cloud, and the hosts the SDK needs are derived from it.

Two things to set in the PostHog project, neither of which this repository can do for you:

- **Cookieless server hash mode**, under Project settings → Web analytics. `cookieless_mode`
  needs it; with it off, events are dropped server-side and nothing in the browser says so.
- **Discard client IP data**, if you want it. Worth checking against the cookieless hash,
  which is computed from the address at ingestion — confirm in the UI that the two coexist
  before relying on both, and say what is true in the policy either way.

Reports travel through `/ingest/*` on this origin rather than to `posthog.com`, because a
request to that host is on every blocklist there is and the people running a blocker are
disproportionately the ones whose bug reports are worth the most. See
`apps/api/src/routes/ingest.ts`, and note that the path needs its `run_worker_first` entry
in every environment or the SPA fallback answers it with `index.html`.

Source maps are uploaded on release, without which every stack reads
`index-CDkkheec.js:1:48213`. That needs `POSTHOG_CLI_API_KEY` and `POSTHOG_CLI_PROJECT_ID`
as GitHub secrets — or exported locally before `pnpm release` — and is skipped silently
when they are absent.

The free tier is 100,000 exceptions a month and stops rather than bills. The reporter's own
cap of five per page load is what keeps a bad deploy inside that: a render loop is five
reports, not five thousand.

`release` rather than `deploy` because bare `pnpm deploy` is a built-in pnpm command that
shadows any script of that name; a `deploy` script does exist, migrations then release, for
deploy flows that look for one by that name, and is reached as `pnpm run deploy`. The first
deploy has to happen before the secrets below: they attach to a Worker, and `wrangler secret
put` fails until one exists — which is why the very first one carries `BETTER_AUTH_SECRET`
in a secrets file, as [Running your own instance](#from-your-laptop) shows.

Past this first setup neither command is routine. `.github/workflows/web.yml` runs both on
every push to `main`, migrations first and then the Worker, so the code never runs ahead of
the schema it was written for, and a merged PR that carries a migration needs nothing done
by hand. `migrate:remote` stays for applying one out of band and is safe to run at any time:
wrangler applies only what it has no record of.

Then the secrets. No `--env` on any of them: the production Worker is the top level of the
config, and an environment flag would aim them at a different Worker.

```bash
cd apps/api
pnpm exec wrangler secret put BETTER_AUTH_SECRET   # openssl rand -base64 32
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put ALLOWED_EMAILS       # comma-separated
pnpm exec wrangler secret put RESEND_API_KEY       # password reset mail
pnpm exec wrangler secret put EMAIL_FROM           # verified sender
pnpm exec wrangler secret put EMAIL_REPLY_TO       # optional, a real mailbox
pnpm exec wrangler secret put POSTHOG_KEY          # optional, error tracking
```

`RESEND_API_KEY` and `EMAIL_FROM` are what make password reset work. Without both, a reset
link is written to the Worker log instead of being sent, which is right for local
development and useless in production — anyone who forgets a password would have no way
back to their notes.

`ALLOWED_EMAILS` is what keeps a public URL from becoming a free notes host: without it,
anyone who can satisfy any enabled sign-in method can create an account. It is a secret
rather than a var only to keep the address list out of the repo. Leaving it empty is
allowed — an instance is not locked to its operator — but a deployed Worker with no
allowlist warns in its log, naming what a stranger could sign up with.

An instance that means to be public says so with `PUBLIC_SIGNUPS=1`, which silences that
warning and nothing else:

```bash
pnpm exec wrangler secret put PUBLIC_SIGNUPS       # 1, to mean it
```

It opens nothing — an empty `ALLOWED_EMAILS` has already done that — so this is a record of
a decision rather than a switch. Without it the warning cannot tell an instance that chose
to be public from one that forgot its allowlist, and on the first of those it becomes a
recurring line about something already settled, which is how a log line stops being read.

### The dev instance

`https://dev.unbent.app` is one standing Worker, `unbent-dev`, deployed from `main` by
`.github/workflows/previews.yml` and configured as `[env.dev]` in `apps/api/wrangler.toml`.
It runs on the `unbent-dev` D1 and the `unbent-dev-blobs` bucket that every preview also
uses, so accounts, sessions and files are one scratch set across all of them, and the
previews bind its note stores too (see [Preview deployments](#preview-deployments)), so a
note is one set across all of them as well. `pnpm seed:demo` is local only — it signs up a
password written into the script — so there is no seeding either of them; they hold
whatever was made there.

It exists because a preview cannot be a stable host, and several things need one:

- **OAuth.** A callback URL cannot be registered against a hostname that changes every PR.
- **Passkeys.** `auth.ts` derives the `rpID` from `APP_URL`, so one enrolled on a preview is
  useless on the next.
- **Mail.** A reset or sign-in link is only worth sending to a host that will still be there
  when the message is opened.
- **The Android app.** `DEFAULT_INSTANCE` is `https://unbent.app`, and the App settings override
  had nothing to point at that was neither production nor gone by morning.

Before it, production was the only instance anywhere with a hostname stable enough to prove
a sign-in flow against — which is a poor place to find out that one does not work.

It is not staging, and should not be treated as one. Nothing in it is backed up, every
preview writes to the same control-plane database, and a PR's D1 migration lands there
before the PR merges — so the dev instance can be briefly wrong for the code `main` is
running. That is the same sharp edge previews have, with the same fix. A change to the note
store's schema has no such edge: it is applied per object, on each object's next wake,
by whichever Worker owns the object.

Unlike a preview it carries the `ai` binding, so it extracts a PDF's text on the server as
production does. An instance is only worth having if the path it exercises is production's,
and extraction is the half of an import that differs most between the two.

#### Google on the dev instance

The [preview sign-in relay](#preview-deployments) bounces to the dev instance for OAuth, so
the relay is only useful if the dev instance can sign in with Google. Two `DEV_GOOGLE_*`
repository secrets configure it, mapped to the plain `GOOGLE_*` names the Worker reads — the
`DEV_` prefix so the dev instance can use a separate OAuth client from production, the way
`DEV_BETTER_AUTH_SECRET` already does. Both or neither: a lone client id with no secret is
not a working provider, so the deploy sends them only as a pair.

The OAuth client — whichever one these secrets name — has to list the dev instance, since a
callback is matched exactly:

- Authorized redirect URI: `https://dev.unbent.app/api/auth/callback/google`
- Authorized JavaScript origin: `https://dev.unbent.app`

Without both secrets the dev instance offers no Google button and the relay falls back to
whatever else the dev instance is configured for (a password, a code by email); without the
console entries the button is there but Google refuses the callback.

#### DNS for `dev.unbent.app`

There is no record to create by hand. `[[env.dev.routes]]` sets `custom_domain = true`, the
same mechanism production's apex uses: on the first `wrangler deploy --env dev` Cloudflare
creates the proxied record, issues the certificate, and manages both from then on. Two
things have to be true first, and on an instance that already deploys production both
already are:

- `unbent.app` is a zone on the same Cloudflare account as the Worker.
- `CLOUDFLARE_API_TOKEN` has **Workers Scripts:Edit**, **Workers Routes:Edit** and
  **Zone → DNS:Edit** on that zone. Production's apex is a custom domain too, so the token
  production deploys with already carries all three.

So the setup is the first push to `main` after `[env.dev]` exists. Verify it landed:

```bash
dig +short dev.unbent.app            # Cloudflare proxy addresses, the same shape as the apex
curl -s https://dev.unbent.app/api/health
```

Certificate issuance takes a minute or two. Until it finishes the name resolves but TLS
fails; that is the certificate still being issued, not a misconfiguration.

| If the deploy fails with | The cause is |
| --- | --- |
| an authentication error, code 10000 | the token is missing DNS:Edit or Workers Routes:Edit on the zone |
| a record already existing for `dev` | something else in the zone owns that name — delete it in the dashboard and redeploy |
| the zone not being found | `unbent.app` is on another account, or another registrar entirely |

If the zone is not on Cloudflare, or you would rather wrangler did not touch DNS: delete the
`[[env.dev.routes]]` block, set `workers_dev = true`, and point `APP_URL` at
`https://unbent-dev.<subdomain>.workers.dev`. A standing Worker's workers.dev URL is stable
too, so OAuth, passkeys and mail all still work against it — only the name is uglier.

To point the Android app at it, put the host in App settings; `Prefs.instance` is per-origin,
so the production session is kept rather than overwritten, and switching back finds it.

### Preview deployments

Every pull request that touches the web app or the API gets a URL of its own —
`https://unbent-pr-<N>.<subdomain>.workers.dev` — where the branch can be used rather than
read. `.github/workflows/previews.yml` deploys it on each push to the PR and deletes it when the
PR closes, and posts the URL as a comment it edits in place on every push.

A preview is a whole Worker, not a static copy of the SPA, because one Worker serves both
halves and `auth.ts` derives its baseURL, trusted origins, cookie security and passkey
`rpID` from `APP_URL`. Cloudflare's own preview URLs share the production bindings, so a
preview built on them would run against the production database with `APP_URL` still
reading `https://unbent.app`, and refuse every sign-in from the preview host as an invalid
origin. That is why the Worker and its `APP_URL` are per PR.

The data underneath is not. All previews share the `unbent-dev` D1, the `unbent-dev-blobs`
bucket and the dev instance's note stores, configured as `[env.preview]` in
`apps/api/wrangler.toml` and served with a stable hostname by [the dev
instance](#the-dev-instance) above — kept well away from production but not from each
other. Accounts, sessions and notes made on one preview are therefore on every other and on
`dev.unbent.app`. It is a scratch environment, and nothing in it is backed up.

The stores are shared by binding the `UserStore` class the `unbent-dev` Worker exports,
and a Durable Object runs the code of the Worker that exports it — so a preview reading
dev's stores runs `main`'s note queries, whatever the PR changed. A PR that touches
`apps/api/src/store/` therefore gets stores of its own instead: the workflow deploys it
without that binding and with `PREVIEW_OWN_STORES=1`, so its own store code is what
answers, and says so on the preview's comment. Those stores start empty, and the empty
note list (and Settings → Maintenance) offers **Fill with sample notes**, which loads the
same invented notes `pnpm seed:demo` does, through the preview's own API. Accounts and the
files bucket are still dev's on such a preview, which is why its Maintenance leaves out
the orphaned-file sweep and the API refuses it.

A preview's sweep does nothing (`STORE_SWEEP = "0"` in its wrangler block, and no
cron): the dev instance's own sweep walks these stores and keeps the directory, and a
second walk running a PR's code would race it.

The environment is called `preview` rather than `dev` because the custom domain cannot live
in a block previews reuse: `--name` changes which script a deploy targets but not which
hostname it claims, so a route here would be taken over by whichever preview deployed last.

Sign-in on a preview leans on the dev instance, through the **preview sign-in relay**. A
callback URL still cannot be registered for a host that changes every PR, so a preview
cannot run OAuth itself — but it does not have to. Its login screen shows **Continue on the
dev instance**, which sends the browser to `dev.unbent.app`, signs in there with Google (or
whatever the dev instance offers), and comes back with a one-time token the preview redeems
for a session of its own. It works because a preview and the dev instance share the
`unbent-dev` database, so a session minted on one is valid on the other, and because the
token is handed only to a host that matches `unbent-pr-<N>.<subdomain>.workers.dev` on the
configured subdomain — the check in `apps/api/src/lib/preview-relay.ts`, which is why the
dev deploy is given `PREVIEW_RELAY_SUBDOMAIN` and the preview deploy `PREVIEW_RELAY_ORIGIN`.

The session is shared rather than copied: redeeming the token sets the *dev instance's own*
session token as the preview's cookie, so the two hold one session between them. Signing out
on either signs you out of both, and the preview's session expires when dev's does. That is
a fair trade for a scratch environment, but it is surprising the first time it happens.

A password with an allowlisted address still works too — the default any instance falls
back to, as ["Choosing sign-in methods"](#choosing-sign-in-methods) describes — as do
passkeys, each bound to the one preview host it was created on. The relay is the fast path;
these are the ones that need no round trip.

D1 migrations are the sharp edge. A PR that adds one applies it to the shared database on
its first preview deploy, and nothing rolls it back when the PR is abandoned. Wrangler tracks
what it has applied by filename, so the stale file is simply never reconsidered — but its
schema change stays, and the next migration written against a schema that does not have it
fails on the preview while passing everywhere else. It reaches `dev.unbent.app` too, which
runs `main` against whatever schema the last preview left. The fix is to recreate the
instance, which costs nothing but the scratch data:

```bash
cd apps/api
pnpm exec wrangler d1 delete unbent-dev
pnpm exec wrangler d1 create unbent-dev   # the next deploy connects to it by name
```

Setting this up on a fresh fork takes three repository settings, alongside the Cloudflare
credentials production already deploys with. The workflow creates the `unbent-dev` database
if the account has none and the first deploy provisions the bucket, so there is nothing to
run by hand; a repository without these settings skips both jobs with a note in the run
summary rather than failing.

| Setting | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | variable | the account's `*.workers.dev` name, from the Cloudflare dashboard |
| `DEV_BETTER_AUTH_SECRET` | secret | a fresh `openssl rand -base64 32`, not production's |
| `DEV_ALLOWED_EMAILS` | secret | who may sign in to a preview or the dev instance |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | secret | the same pair production deploys with, needing D1 and R2 edit scopes, plus the DNS scope [the dev instance](#dns-for-devunbentapp) describes |
| `DEV_INSTANCE_ORIGIN` | variable, optional | where a preview's sign-in relay sends people; defaults to `https://dev.unbent.app`. Set it only if your dev instance has a different name |
| `DEV_GOOGLE_CLIENT_ID`, `DEV_GOOGLE_CLIENT_SECRET` | secret, optional | Google on the dev instance, so the relay can sign in with it; both or neither, and the client must list `dev.unbent.app` — see [Google on the dev instance](#google-on-the-dev-instance) |
| `DEV_TYPESAFE_API_KEY` | secret, optional | Auto-fill on the dev instance and every preview; a key of its own, so what they spend stays apart from production's — see [Filing a note from what it says](#filing-a-note-from-what-it-says) |
| `DEV_ANTHROPIC_API_KEY` | secret, optional | Auto-fill's language model on the dev instance and every preview; a key of its own, for the same reason — see [Reading images](#reading-images) |
| `DEV_OPERATOR_EMAILS` | secret, optional | who is an operator on the dev instance and every preview, sent as their `OPERATOR_EMAILS`. Not implied by `DEV_ALLOWED_EMAILS`; unset, nobody is, and anything operator-only cannot be tried outside production. Removing it later leaves the dev instance's last list in place until `wrangler secret delete OPERATOR_EMAILS --env dev` |
| `DEV_SWEEP_TOKEN` | secret, optional | the dev instance's `SWEEP_TOKEN`, so its deploy ends with a sweep of its note stores as production's does; its own value, not production's. Previews get none and never sweep |

The subdomain is a variable rather than a secret because the workflow has to build the URL
before deploying — `APP_URL` is baked in at deploy time — and a masked value would arrive
in the PR comment as `***`. It doubles as the dev instance's `PREVIEW_RELAY_SUBDOMAIN`, the
allowlist its end of the sign-in relay checks a preview's return origin against.

Fork PRs get no preview. `pull_request` withholds secrets from them, so there would be
nothing to deploy with; the job skips rather than failing halfway.

### Choosing sign-in methods

Nothing here is compiled in. An instance decides what it offers through its environment,
and `GET /api/config` reports the result — the web app and the Android app both draw their
sign-in screens from that, so a method that is not configured is never shown.

**Configure nothing and you get a password and a passkey.** Every instance can be signed in
to; there is no combination of settings that leaves a working deployment with no way in
except asking for one. That guarantee is worth stating because two of the four methods
cannot stand on their own: a passkey is added from an account you already have, so it is
never what gets you in the first time, and a code by email needs somewhere to send it.

| Method | Offered when | Withheld when |
| --- | --- | --- |
| Any OAuth provider | `<PROVIDER>_CLIENT_ID` **and** `<PROVIDER>_CLIENT_SECRET` | either is missing |
| Email + password | nothing else can create an account, or `AUTH_PASSWORD=1` | something else can, or `AUTH_PASSWORD=0` |
| Code by email | `RESEND_API_KEY` **and** `EMAIL_FROM` | either is missing |
| Passkeys | always | `AUTH_PASSKEY=0` |

The password row is the floor. It appears on an instance with no OAuth and no mail, and
withdraws as soon as either arrives — so a self-hoster who configures nothing still gets in,
and unbent.app, which has providers, never sees it. `AUTH_PASSWORD=1` asks for a password
*alongside* a configured provider; `AUTH_PASSWORD=0` refuses the floor, and is the one
setting here that can leave nobody a way in.

An instance that accepts a sign-up from anyone says so in its log: deployed with an empty
`ALLOWED_EMAILS`, the Worker warns once, naming the methods a stranger could use. Set
`PUBLIC_SIGNUPS=1` to say the open door is deliberate and stop the warning; who may sign up
is unchanged either way.

The OAuth row means any of the thirty-five providers Better Auth ships — Apple, Discord,
Microsoft, Slack, GitLab and the rest — not a list this repository maintains. Enabling one
is two secrets and no code:

```bash
pnpm exec wrangler secret put DISCORD_CLIENT_ID
pnpm exec wrangler secret put DISCORD_CLIENT_SECRET
```

Retiring one is `wrangler secret delete` on either half. Both take effect on the next
request, without a deploy.

The sign-in screens need no change for a provider they have never heard of: the button is
labelled from the provider's own id, with a small table of exceptions for names that
title-casing gets wrong (GitHub, GitLab, LinkedIn). Android shows one "Continue in a
browser" button for every non-Google provider rather than one each, because a phone has no
native account picker for an arbitrary provider and they all end at the same page.

#### Enabling a provider means trusting how it verifies email

Better Auth links a new provider to an existing account when the emails match, so that
somebody who signed up with Google and later presses a different button arrives at their
own notes rather than a second, empty account. Two conditions gate that: the local account
must already be verified, and either the provider must be listed in `trustedProviders` or
it must claim the address is verified.

The consequence is worth stating plainly, because enabling a provider is now one command.
**A provider that will assert `email_verified` for an address its user does not own can be
used to reach an existing account at that address.** Google and GitHub do not do this.
Providers where the address is user-settable, or that were built for a single organisation
and assume the operator controls the directory, historically have — this is the "nOAuth"
class of bug, and it is a property of the identity provider rather than of this code.

So: enable providers you would be willing to let someone sign in as. If you enable one you
are unsure about, turn implicit linking off in `apps/api/src/auth.ts`:

```ts
account: { accountLinking: { disableImplicitLinking: true } },
```

Accounts then link only when someone explicitly asks while already signed in, and a second
provider on an existing address is refused rather than merged. It is the safer setting and
the more annoying one — someone who signed up with Google and then presses Discord is told
the account is not linked instead of being let in.

`ALLOWED_EMAILS` narrows this considerably on a closed instance: an address that cannot
create an account cannot be linked into one either.

Two things to know before removing a provider people already use. An account whose only
credential is that provider loses its way in, so check before deleting. And deploy the
replacement first — a secret deletion takes effect immediately, while new code does not.

OAuth callbacks have to be registered against the real origin before anyone can sign in,
including you:

- Google: `https://unbent.app/api/auth/callback/google`
- GitHub: `https://unbent.app/api/auth/callback/github`
- Apple: `https://unbent.app/api/auth/callback/apple`, on the Services ID — see below

Then deploy again so the Worker picks up the secrets. `custom_domain = true` means
Cloudflare creates and manages the DNS record and certificate, so there is nothing to add
by hand:

```bash
pnpm release
```

#### Sign in with Apple

Apple is the one provider whose secret is not a value it hands you. `APPLE_CLIENT_ID` is a
**Services ID** — an identifier you create on the developer portal, with Sign in with Apple
enabled and the callback above as its return URL — and `APPLE_CLIENT_SECRET` is a JWT you
sign with a Sign in with Apple key, which Apple refuses once it is more than six months
old. `scripts/apple-client-secret.mjs` makes one from the team id, the key id and the
`.p8`, and pipes it into wrangler without printing it:

```bash
node scripts/apple-client-secret.mjs --team TEAMID --key-id KEYID \
  --client-id com.example.notes.web --key AuthKey_KEYID.p8 \
  | pnpm --dir apps/api exec wrangler secret put APPLE_CLIENT_SECRET
```

It prints the expiry date; put a reminder a week before it. A lapsed secret breaks only the
web Apple button, at the code exchange, while every other way in keeps working — which is
why it goes unnoticed. Generating the token in the Worker from the key itself would retire
the reminder, and is left for later.

Apple returns from its web sign-in by having its own page post the result to the callback
(`response_mode=form_post`), so that request arrives from `https://appleid.apple.com`.
The Worker trusts that origin only while Apple is configured. Apple accepts no `http` or
`localhost` return URL, so the button is tried on a deployed instance, not in development.

Apple sends a person's name only on their first authorization, and never inside the
token. The web flow keeps it; the iOS app, signing in natively, sends it to
`/api/auth/update-user` itself when it has one.

## Auth

Better Auth. Any of its thirty-five OAuth providers by convention, plus passkeys, codes by
email, and email-and-password. A social provider without configured credentials is simply
not offered, so local development works with none of them set.

Password sign-in exists for self-hosted instances: OAuth needs a callback URL registered
with each provider per deployment, which cannot be done on anyone else's behalf, while a
password works anywhere. It is offered by default only where nothing else could create an
account, so unbent.app — which has providers — does not show it. `ALLOWED_EMAILS` gates
account creation whatever the method. See [Choosing sign-in
methods](#choosing-sign-in-methods).

`GET /api/config` reports which methods an instance offers, in display order, so the login
screen and the Android app render from it rather than guessing.

Sessions are cookie-based and same-origin. Better Auth enforces CSRF by requiring a trusted
`Origin`, so API clients outside the browser must send one.

## Connecting an AI assistant

Unbent is an [MCP](https://modelcontextprotocol.io) server, so Claude, Cursor, ChatGPT or
anything else that speaks the protocol can work with your notes directly. The server URL is
`https://unbent.app/api/mcp` — no trailing slash, and no API key to copy anywhere.

Connecting runs the ordinary OAuth flow: the client registers itself, a browser opens on the
consent screen, and approving it hands the client a token of its own. The tools cover
search and list, reading a note in full, create, edit, tag, move, trash and restore — create
and the last four for several notes at once — attaching a file, and notebook management. Note bodies are Markdown and pass whole in both
directions, so an assistant writes a complete note in one call.

Three are worth knowing about:

- **`edit_note`** takes `append`, `prepend`, or `replace` with an exact `find` string, so
  changing one line of a long note does not mean resending it. A `find` matching more than
  once is refused with the count rather than guessed at.
- **`get_attachment_text`** returns the text held for a file: a PDF's text layer, which is
  what makes a scanned bill answerable; what the vision model read off a picture or a
  text-less scan when someone pressed Auto-fill on its note; or what an assistant recorded
  itself. A picture nothing has read yet is reported as waiting, and no tool makes the
  instance's model read it — that runs only inside a press (MAK-179). Instead
  **`get_attachment`** hands the assistant the picture itself, as an image under about 3.7 MB, to
  read with its own model on its own bill, and **`set_attachment_text`** records what it
  read, marked `assistant`, so search and the summaries have it. It may fill a file that
  has no text, an empty row or its own earlier words, and never a text layer or the model's
  reading; the next Auto-fill press on the note has the model read the file itself and
  replaces it. See [Searching inside PDFs](#searching-inside-pdfs). Before any of that, `get_note` —
  and `list_notes` or `search_notes` with `attachmentSummaries` — already give each file a
  line of what it is: the vision model's name and description for a picture or a text-less
  scan; for a text layer, its opening and then the total, dates, order number and amounts
  found in it by pattern, so a receipt's total at the foot of the page is in the line; or
  whether it is still waiting. No language model writes a text layer's line: the summary is
  worked out from the text each time it is asked for, so every file has one and there is
  nothing to backfill.
  Filling a notebook's fields from its receipts is then a page of a hundred notes read in
  one call, rather than two calls for every note. Where the line is not enough,
  `get_attachment_text` takes `maxChars` to return only the opening of the text, the part
  a receipt's merchant and total are in, rather than the pages of terms after it. A cut
  answer says how long the whole text is, and `offset` reads on from where it stopped.
- **`add_attachment`** takes a URL, not bytes. A tool call is JSON the model writes token by
  token, so a file cannot ride in one — a scan as base64 is millions of characters, past
  what any client carries. What an assistant can hand over is the download link another
  system gave it when it read the page (a signed URL, typically good for an hour), and the
  Worker fetches that itself and stores the result exactly as an upload from the editor.
  The reply carries the filename it was stored under and the Markdown that shows it, which
  is appended to the note unless the assistant asks to place it. A file with no link — one
  on the assistant's own disk, or a screenshot in its sandbox — goes the other way:
  **`prepare_attachment_upload`** hands back a one-time URL, and the assistant's shell
  sends the bytes there with `curl -T`. The reply to that request is the same as
  `add_attachment`'s. The link works once, for one note, for half an hour, and needs no
  token beside it, so the shell never holds the client's OAuth credentials. The one
  requirement is that the assistant can reach this instance over the network: a sandbox
  that restricts where it connects needs the instance's domain allowed. There is still
  deliberately no tool that takes the bytes as an argument: it would work only for files
  small enough not to matter, and fail silently above that.

**Approving a client gives it standing access to everything.** It can read every note,
create and change notes, and move them to the trash, from then on and without asking again.
Settings › Connected apps lists what is connected and disconnects any of it; disconnecting
deletes the app's tokens, and the endpoint checks the grant on every call, so access ends
rather than lingering until a token expires. There is deliberately no tool that deletes
permanently — the trash is as far as an assistant can go. And what an assistant's edit
replaces is kept: see [Undoing an edit](#undoing-an-edit).

Client registration is open, because clients register themselves at connect time and there
is no way to pre-provision credentials for software you have never heard of. A registered
client with no approved consent can read nothing; the registration endpoint is rate limited
so the table cannot grow quickly. A public client whose redirects are all `http://localhost`,
`127.0.0.1` or `[::1]` is registered as a native app even when it does not say so, as the
MCP SDK does not; one that keeps a secret and redirects to this machine is refused with a
message saying to register it as native.

Locally, point the client at the **SPA** origin rather than the Worker's — the port
`pnpm dev` prints first. Tokens are bound to the MCP endpoint's URL as their audience, and
that URL is built from `APP_URL`.

## Editing

**The goal is WYSIWYG.** Bold looks bold, headings are sized, task lists get real
checkboxes, attachment images render inline, and tables are edited with buttons rather
than by hand. Markdown is the storage format, not the interface — nobody should have to
count pipe characters to add a column.

What we will not do is get there the usual way.

### Why not a document model

The standard WYSIWYG approach parses Markdown into its own document model, holds that
model as the source of truth, and re-serializes on save. The round trip is where notes get
damaged. TipTap 3, run against real notes from this corpus, turns `](<files/My File.pdf>)`
into a broken link, escapes underscores in filenames, and normalizes `_italic_` to
`*italic*`. None of those edits were asked for. Each one is a small, silent, permanent
rewrite of a file the user believes they own.

That is disqualifying here, and not only on aesthetic grounds: a broken attachment link is
a note whose PDF no longer resolves, and this archive is mostly PDFs.

So the real constraint is narrower than "no WYSIWYG":

> **The document text is the only source of truth, and every edit is an ordinary text edit
> the user could have typed by hand.**

WYSIWYG *behavior* is entirely compatible with that. WYSIWYG *architecture* — a parallel
document model that owns the truth — is not.

### How it works instead

CodeMirror 6 edits the Markdown directly, with a rich mode that styles the source in
place. Syntax characters hide unless the cursor is inside the node they belong to, so
reading stays clean and editing stays direct. The text never leaves the buffer, so there
is no parse-and-reserialize step in which it could be rewritten.

Every affordance is built on top of that rather than around it:

- A toolbar and the usual shortcuts (⌘B, ⌘I, ⌘K, ⌘⌥1) apply formatting as text edits.
- Tab and Shift-Tab indent and outdent list items; outside a list Tab moves focus as
  usual, so the editor is never a keyboard trap.
- Tables get a toolbar anchored to the table the cursor is in — insert and delete rows and
  columns, set column alignment, and a grid size picker for creating one. Restructuring a
  Markdown table by hand means editing every row plus the delimiter, so the tedious
  operations get buttons; each one is still a plain edit through
  `apps/web/src/editor/markdown-commands.ts`, which rewrites the table's text and lets
  CodeMirror's history record it as a single undo step.
- Dragging a file in shows a drop cursor at the exact insertion point.
- An Attach button in the toolbar opens the file picker, for a phone and for anyone who
  would rather not drag. It goes through the same routine as a drop or a paste: a
  placeholder at the cursor, replaced by the link when the upload lands, one undo step.

The test for any new editing feature is the same one every time: **can it be expressed as
an edit to the text, undone with a single ⌘Z, and retyped by hand to the same result?** If
yes, it belongs, however rich it looks. If it needs a parallel document model, it does
not, however convenient that would be.

Rendering uses GFM (tables, task lists, strikethrough, autolinks) plus soft line breaks:
a single newline is a line break, not a space. CommonMark folds lone newlines into spaces,
which turns a note written as separate lines into one run-on paragraph — pressing Enter in
a notes app should start a new line. Soft breaks are not part of GFM itself; they are a
separate remark plugin.

### Still to build

Toward the same goal, under the same constraint: inline image resizing, a link editor that
does not require selecting the whole `[]()`, and drag-to-reorder for list items.

## Search

FTS5 over note titles and bodies, weighted 10:1 toward titles. The index is
external-content (`content='notes'`), so it references the notes table rather than storing
a second copy of every body.

Rows must be removed from the index with FTS5's `'delete'` command carrying the old column
values. A plain `DELETE FROM notes_fts` does not error — it silently corrupts the index,
and the damage surfaces later as edited or deleted notes still matching their old text.
`test/search.test.ts` asserts this directly; introducing the plain-DELETE form makes three
of those tests fail.

To rebuild the index from scratch: `INSERT INTO notes_fts(notes_fts) VALUES('rebuild');`

### Filtering and sorting

Search takes the same `tag`, `notebook`, `from`, and `to` filters as the note list, so
typing a query narrows the current view instead of escaping it — with a notebook selected,
"insurance" means "insurance in here". The clauses are shared by `list`, `count`, and
`search` through one helper so a filter cannot come to mean two different things, and they
apply inside both search CTEs: the note index and the attachment-text index each join
`notes` separately, so scoping only one would still surface notes from outside the filter.

The list is ordered by `sort` (updated, created, title) and `order`. Search is not: results
come back ranked by relevance, and reordering them by date discards the ranking that makes
them worth showing, so the sort control is hidden while searching.

Sorting and keyset pagination have to agree — the cursor compares against the column that
ordered the query, so `SORTS` in `apps/api/src/lib/notes-repo.ts` pairs each sort with its
column and its cursor rather than leaving the route to know which is which. The cursor also
carries the row id, because comparing the sort key alone is only safe when it is unique and
titles are not: an archive is full of notes called "Receipt", and paging nine identically
titled notes returns four without the tiebreak.

Date bounds are `YYYY-MM-DD`, inclusive at both ends, read in UTC to match the epoch-ms
columns. The range filters the date the sort's rows show — updated or created, and updated
under the title sort, which has no date of its own — so the filter and the row always mean
the same date; search, having no sort, filters on `created_at`.

### Acting on several notes

The list has a selection, in the shape people arrive with from Evernote. Cmd/Ctrl-click
toggles a note into it — the open note comes along with the first — and Shift-click selects
a run from the last one picked (or from the open note); on a touch screen a finger resting on a note for half a second selects it, and
while anything is selected a tap toggles notes rather than opening them. Space picks the
focused note, Cmd/Ctrl+A picks every loaded note, Escape clears. The table view has a
column of checkboxes with a select-all in its header as well. A bar floats up over the foot
of the screen with the count and the actions: move to a notebook (an existing one, or a
name that makes a new one), add or take away tags, delete. In the trash the same selection
restores or permanently deletes. Opening a note or changing the filters drops the
selection, so an action can never reach notes that are out of view — and Select all reaches
what is loaded, not what the filter would match.

The API is `PATCH /api/notes` with `{ ids, notebook?, addTags?, removeTags? }`, and
`POST /api/notes/trash`, `/api/notes/restore` and `/api/notes/purge` with `{ ids }`. Each
answers with a count. A note already in the notebook, or already carrying the tag, is left
alone and keeps its date; ids that are not the caller's, or on the wrong side of the trash,
are counted out rather than failing the request. Up to 500 ids per call.

## Searching inside PDFs

Most notes in a real Evernote export are a scanned PDF with an empty body — in one notebook,
90 of 108 sampled notes had zero body text. Searching note text alone would never find them.

Evernote already ran OCR on those scans and embedded the text layer, so the import extracts
it with pdf.js rather than re-OCRing: about 80% of real scans yield usable text, median ~8k
characters. It lands in `attachment_text`, indexed by its own FTS5 table, and search unions
both indexes — note matches rank above attachment matches, and a hit from a file reports
which file it came from.

Roughly a fifth of scans produce character noise instead of language (`> CO 5 I > — O —`).
Those are filtered out rather than indexed. Much of the usable text is letter-spaced
(`H a r b o r v i e w`), which is rejoined so the word is actually findable.

**When it runs.** The editor extracts text from a PDF the moment its upload returns, from the
bytes already in hand, so a file dropped into a note is searchable seconds later. The Android
app does the same for a capture by loading `/embed/index-files?note=…` in a WebView nobody
sees — the site's own extractor, run by the phone for the one note it just made. And the
app runs a pass over whatever is still pending each time it opens, so a file either of those
missed is caught the next time anyone looks.

**On the server, where it can.** unbent.app binds Workers AI, and the upload handler hands a
PDF to its document conversion after the response is sent, then records the text itself — so
every client gets a searchable PDF without doing anything, and the editor, the import and the
phone skip their own extraction when the upload says `indexing: "server"`. The conversion
reads the text layer, as pdf.js does; measured on fifty scans from a real export, the two agree
on which files have text and which have none, with a median word overlap of 0.89. Its output
opens with the file's metadata — PDF version, the scanner's name — which is stripped before
indexing, or every scan from the same scanner would match a search for it. Files over 25MB, a
deployment without the binding, and any failure fall back to the browser paths above; only a
conversion that read the file and found nothing closes the row. The binding is on every deployed
instance and left out of the `local` environment in `wrangler.toml`, since a `wrangler dev`
with it needs a Cloudflare login to start, so local development keeps extracting in the
browser.

That pass stops short of a backlog: more than one page of pending files and it downloads
nothing, because it pulls the same bytes the button does and a backlog is gigabytes that must
not start flowing because a tab was opened on a phone. The sidebar says what it left, and
"Index existing PDFs" on the Maintenance page is where that gets run.

**Backfill.** Import is idempotent on content hash, so notes imported before extraction
existed cannot be fixed by re-importing — they are skipped along with their attachments.
"Index existing PDFs" walks the gap instead, extracting text for any attachment that does
not have it yet. `GET /api/attachments/pending-text` says what is still missing, scoped to
one note with `?note=`, which is how the phone asks for its own capture and nothing else.

### Reading images

A text layer is the only text a file had, so a photo of a receipt, a business card, a plate
of food or a whiteboard was nothing to search and nothing for Auto-fill to read, and so was
a scan that was never OCR'd. With an Anthropic API key, Auto-fill reads those with a vision
model:

```bash
cd apps/api
pnpm exec wrangler secret put ANTHROPIC_API_KEY
```

Locally, the same name in `apps/api/.dev.vars`; `DEV_ANTHROPIC_API_KEY` as a GitHub secret
carries a separate key to the dev instance and previews. Without one, pictures have no text,
as before, and nothing is sent anywhere.

The model is asked for one fixed shape — a short name for the file, what kind of thing it is,
a sentence or two on what it shows and the facts someone filing it would want, and every
legible word transcribed — and the whole of it becomes the file's text, in that order. The
same row search indexes and Auto-fill reads, so a photo of a card fills a Contacts notebook's
fields the way a scan fills Receipts, and "lasagna" finds the plate. `get_attachment_text`
over MCP returns it too.

**When it runs: only when someone presses Auto-fill.** The press reads the note's own
unread files first — its pictures, and a scan whose text layer turned out empty, whether
the server's conversion found nothing or the browser's did — up to five at a press, with
the rest reported as still waiting, and then suggests from what they say. That is the one
place the instance calls the model to read a file, and the press is the person asking for
it. Never for a PDF that has a text layer: the free reader goes first, and the paid one only
gets what it leaves. The bytes go to Anthropic and are not kept there; each file is read
once, and a decline is recorded so it is not asked again.

A picture nobody presses Auto-fill for stays unsearchable, and that is the trade, made in
MAK-178. Until then every picture was read as it arrived — from the editor, the phone, an
import or an assistant — and a bulk pass on the Maintenance page read the backlog: on a
real archive thousands of paid requests nobody asked for, and every one of them a photo
leaving the instance that its owner never chose to send. Cost that grows with uploads cannot
be covered by a flat price, and a press is consent where an upload is not.

**An assistant can read a picture itself.** Over MCP, `get_attachment` returns a picture as
an image for the assistant's own model, and `set_attachment_text` records what it read,
marked `assistant` beside the layer's and the model's text. Those words are a hint for
search and the summaries, not the document: the next Auto-fill press on the note has the
instance's model read the file and replaces them, and an assistant may never write over a
text layer or the model's reading. The instance calls no model for any of it, and the
bytes go to the assistant the person connected, nowhere else.

**Which model.** The model has three jobs inside a press — reading the files, writing the
title, writing the text field values (see [Filing a note from what it
says](#filing-a-note-from-what-it-says)) — and each has a variable: `ANTHROPIC_READ_MODEL`,
`ANTHROPIC_TITLE_MODEL` and `ANTHROPIC_FIELDS_MODEL`, each falling back to `ANTHROPIC_MODEL`
and then to `claude-haiku-5-5`. The reading is the one whose cost grows with what you keep,
so it was measured on forty-five hard files from a real archive — faded receipts, business
cards, handwritten forms, scans with no text layer, a twenty-two-page lease — against an
answer key of 261 facts. Haiku 5.5 read 240 of 243 right; Sonnet 5.5 read every one of its
236 and Opus 5.5 all but one. Every model read every phone number, email, merchant and
total; the difference was one handwritten form, a word and a date. A read cost about 0.1¢ on Haiku, 1.6¢ on Sonnet and
3.3¢ on Opus, and Haiku was the fastest. So Haiku is the default for every job, and the
dearer models buy handwriting and nothing else measurable. If your archive is handwriting,
set `ANTHROPIC_READ_MODEL=claude-sonnet-5-5` and leave the title and the fields on Haiku:
those only copy words off a reading already made, and gained nothing from a bigger model.

`ANTHROPIC_READ_EFFORT` is how hard the reading model thinks, `low` to `max`. Unset, the
default model reads at `low`, which on the same sample tied `medium` and `high` on what it
read and was the fastest and cheapest — thinking harder does not change what is on the page.
A model you name gets no effort unless you set one, and beside a Sonnet read you should set
`low`: at its default effort its thinking alone fills the output budget on a long scan, and
the read never finishes. The whole of it sits behind one interface in
`apps/api/src/lib/llm.ts`, so another model, or Workers AI for an instance that would rather
keep images in place, is one more implementation of it.

## Filing a note from what it says

A scan arrives as an untitled note in the Inbox holding one PDF, and filing it — a title, a
notebook, tags, the amount and the date copied into the notebook's fields — is the same
minute of work for every one of thirteen thousand. **Auto-fill**, in a note's head, does that
minute: it reads what the note and its files say and fills in whatever is empty, and asks
before replacing anything already set. What it fills lands in the editor's draft like a
typed value, so it saves when the note saves and is undone by retyping.

It is on when the instance has a key for [Jev](https://docs.typesafe.ai), TypeSafe's model
for exactly this shape of question, and drawn nowhere otherwise:

```bash
cd apps/api
pnpm exec wrangler secret put TYPESAFE_API_KEY
```

Locally, the same name in `apps/api/.dev.vars`. A key of its own for development keeps its
usage apart from production's.

**What is sent, on each press.** The note's title and body, the text already extracted from
its PDFs (see [Searching inside PDFs](#searching-inside-pdfs) — a scan that has not been read
yet is reported as such rather than guessed at, and a photograph's text is what the press
itself reads first, where the instance [reads images](#reading-images)), and
the names of your notebooks, tags and fields, with a few recent titles from each notebook and
tag as examples of what belongs there. Nothing else in the archive. Nothing is sent until the
button is pressed.

**Why Jev.** It chooses rather than writes: the notebook, the tags and every select or
checkbox are choices among things that already exist, so it cannot invent a notebook or
misspell a tag, and each answer comes with a confidence. For free-form fields the code finds the
candidates — every date the text writes for a date field, every amount for a number, the
document's own lines for a text field — and the model picks one or says none of them. The
title is written rather than chosen: where the instance has a language model, the same key
that [reads images](#reading-images), it is asked for the title a careful person would give
the note, and Jev's pick of the document's own lines stands where there is none. The same
model writes a text field's value, so a Vendor gets "Acme Rentals" rather than the whole
"Thank you for shopping at Acme Rentals Store #4471" line, and a value it writes is kept
only when the document contains it. Without one, a line written as a label and a value,
like "Order number: 112-0042", offers the value alone too. A value can still be wrong, but
it is always something the document actually says, and anything the model is unsure of is
left empty rather than guessed. Ratings are left alone: a document has no opinion to read.

**What it costs, and the ceiling.** Every press is counted per account, and so is every
token the language model is paid for inside one — by day, by job (reading a file, the
title, the fields) and by model, since a token's price is the model's. Maintenance shows
the account's presses and tokens for the year. A press is one request anyone signed in can
send in a loop, so `AUTOFILL_DAILY_CAP` sets how many one account may make in a UTC day;
past it, the button says how long until it works again. Unset, nothing is refused.

`POST /api/notes/:id/autofill` answers with the suggestions and applies nothing; the client
does. The Android app is the site in a WebView, so it has the same control.

## Your library on the device

The installed app — and the Android app, which is the site in a WebView — opens with no
signal and works. A service worker keeps the app itself on the device, and your library
lives there too: the notes, notebooks and tags of the signed-in account, in a SQLite file in
the browser's private storage, copied from the server the first time you sign in on a device
(a line across the top counts the notes as they arrive, and a copy interrupted by closing the
app picks up where it stopped) and kept current by the change feed
after — on open, when you come back to the tab, and the moment another device saves,
through a socket that says only that something changed. A warm open draws the list with no
request at all. One tab or window holds the library file at a time, and every other tab
of the same account works through it — reading the same copy, saving into the same queue,
offline included — so nothing tells them apart. Settings → Offline says which tab holds
the file and moves it to the one you are in with one press.

Edits land on the device first. A note you write, make, file, tag, trash or restore with
no connection is saved here at once — the note head says "Saved", with a small cloud
beside it until the server has the note too — and goes to the server, in order, when the
connection returns. A save that would overwrite
an edit made on another device meanwhile is refused there and put to you as before: reload
theirs, or keep yours on top of it. What needs the server now says so and waits:
Auto-fill, and the settings pages that manage notebooks, tags and fields. A lost connection
is never taken for signing out.

Search works without a connection too. The device keeps an index of its own beside the
library — the same FTS5, stemmer and ranking the server uses, in the SQLite the library
already runs in the browser — over
every note's title, body, tags and field values, and with no connection the search box asks
it instead: the same results, the same filters. The text inside files is the exception. It
is the largest thing an account stores after the files themselves, so a device holds it
only for the notebooks it keeps offline and for the last five hundred notes opened on
it (up to about 20 MB of text between them, newest first), and a line under the results says when a search was answered on the device and how many
files' text it could not see — "No matches" offline should never be read as "not in your
notes". When the connection returns the same search is asked of the server, and its answer
replaces the device's in place.

Files are the bulk of an archive, so they are on the device by choice rather than by
default. A file you open is kept, within a budget — 500 MB, the ones opened longest ago
going first. A notebook can be kept whole: its page offers **Keep offline**, says how big
that is and how much room the device has before it starts, and from then on fetches the
notebook's files, including ones added later from another device. A file added to a note
with no connection is held on the device, shown in the note at once, listed as waiting, and
uploaded when the connection returns. A file that is not on the device says "Not available
offline" where it would be drawn. Settings → Offline shows what the device is holding and
gives the room back.

Signing out removes the library and its files from the device, as does deleting the account
or another person signing in. A sign-in that has expired does not: your copy stays, closed, and signing
in again reopens it and sends whatever you changed while it waited. The rules the code is
held to are in `apps/web/src/store/` and AGENTS.md.

## Local database

`pnpm --filter @unbent/api db:reset` rebuilds the local D1 from migrations and clears the
local note stores, copying both into `.wrangler/backups/` first. Use it instead of removing
the state directory by hand — that has no undo and has already cost one set of local notes.
The two go together: local notes live in Durable Objects under `.wrangler/state/v3/do/`,
keyed by the user ids in D1, and resetting one without the other leaves ghost objects
behind — notes with no account, or a fresh account whose first open finds an object already
holding someone's earlier state.

## Undoing an edit

The trash covers a note that was deleted. A note that was changed for the worse — a paste
over the wrong selection, an assistant's `edit_note` that replaced more than it was meant
to, a batch that refiled the wrong forty notes — is covered by its history: **History** in
a note's ⋯ menu lists earlier versions, shows any of them as the note would read, shows
what restoring it would change, and puts one back.

A version is the note's title and body, and its notebook, tags and field values. In a
notebook that is mostly fields — a watch list, a log, a set of business cards — the fields
are the note, and changing only those keeps a version like any other edit.

A version is kept when a write changes the note, and how often depends on who is writing:

- **Your own edits** keep one version per half hour: the note as it was before the sitting
  began. The editor saves about once a second while you type, and a version per save would
  be a copy of the whole note per pause. A run of field changes is one version, not ten;
  so is tagging or moving a selection of notes from the list.
- **An assistant's write** over MCP keeps what it replaces even inside that half hour,
  whether it rewrites the text, sets a field or refiles a batch. The usual assistant edit
  arrives minutes after you stopped typing, and what it replaces is exactly what is worth
  having back. A run of edits by an assistant leaves one version, the note before the run,
  so a long job cannot push your own text out of the history.
- **A restore** keeps what it replaces, always. Restoring is undone the same way it was
  done, and the message that follows one has an Undo.

Restoring puts the fields, tags and notebook back with the text, as far as they still fit.
A notebook, tag or field deleted since stays deleted, and a value its field can no longer
hold — the field was converted, or lost that choice — stays as the note has it. The
Changes view says so beforehand and the message after the restore names what was left;
the rest of the version is restored either way. What a notebook's or a tag's own settings
do to every note under them (a rename, a field converted) is not a note's history, and a
restore does not undo it.

The newest fifty versions of a note are kept, and none for longer than a year. It is
a safety net for a recent mistake rather than an archive: versions are not in an export
and are not copied to your devices, so the sheet needs a connection. They do not hold
files, so a version shows its pictures and files as they are now, and a file deleted since
stays deleted. Versions kept before fields, tags and the notebook were part of one hold
text only; restoring one of those leaves the rest of the note as it is.

It also means that text you delete from a note is not gone at once. A password pasted into
a note and then removed is still in that note's History, for anyone signed in to the
account, until the version ages out. **Clear history**, at the foot of the sheet, deletes
every version of that note for good and leaves the note as it is; it asks first, since it
is the one thing in the sheet that cannot be undone. What it cannot reach is the thirty
days of point-in-time recovery every store keeps (see [Where your notes
live](#where-your-notes-live)): an operator winding the whole account back to before the
clear would bring the versions back with everything else; nor the daily dumps, which hold
the store whole and age out within about three months (see [Durability](#durability)).
Emptying
the trash takes a note's history with it, and deleting the account takes all of it.

The API is `GET /api/notes/:id/revisions`, `GET /api/notes/:id/revisions/:revision`,
`POST /api/notes/:id/revisions/:revision/restore` and `DELETE /api/notes/:id/revisions`.
There is no MCP tool for it yet: an assistant can cause a version to be kept, but only a
person can put one back.

## Deleting notes

Note deletion in the app is a soft delete — the note goes to trash and its attachments stay
in R2 so a restore is not left with dead links. To reclaim that storage, Settings has a
Maintenance page:

- **Empty trash** — permanently deletes soft-deleted notes and their files.
- **Sweep orphaned files** — removes R2 objects with no attachment row. Files you
  unlinked from a note still have a row; delete those from the note’s Attachments list.
- **Delete all notes** — wipes every note and attachment in the account. Requires typing
  `DELETE`, since nothing in your own hands reverses it: an export is the only way back
  you hold, and an operator's wind-back or dump load (see [Durability](#durability)) is
  theirs to offer, not a control of yours.

The API equivalents are `POST /api/admin/purge-notes?scope=trashed|all&confirm=DELETE` and
`POST /api/admin/gc-blobs?apply=1`. Both are scoped to the caller's own data.

**Deleted files follow the store for thirty-five days.** Emptying the trash, deleting a
single note from it and deleting a file from a note remove the rows at once, but not the
objects: the store writes each file's key to a table of deleted files (`deleted_blobs`,
schema 0005) in the transaction that removes the row, and the hourly sweep deletes from R2
only what has sat there for thirty-five days, then has the store forget it. Nothing a
person can do brings a purged note back — this is for the operator. A store keeps thirty
days of history, and [winding one back](#where-your-notes-live) winds the table of deleted
files back with the rows, so a restored note finds its files still in the bucket; the five
days on top are so a restore to the far end of the window still finds them. The account's
own file sweep counts a file awaiting deletion as referenced for the same reason, and
reports it as `awaitingDeletion`. Deleting an account is the exception: its files go at
once, as they always did, because the account's deletion is what its owner asked for.

For local development, `pnpm --filter @unbent/api reset:local` clears D1, R2 and the note
stores entirely and rebuilds the schema, backing up D1 and the stores first. Use that rather
than the in-app sweep to clear fixtures left by deleted test users — the scoped sweep cannot
reach another account's prefix by design.

## Selling the plan

unbent.app sells one plan, $36 a year, with 10 GB of attachments and 25 GB more for $12 a
year (the reasoning is in MAK-47). Paddle is the merchant of record: it takes the payment,
handles VAT and sales tax, and tells the Worker what happened over a webhook. Nothing about
it exists on an instance that has not set the five `PADDLE_*` settings — every account is
active for good there, and no Plan tab is drawn — so a fork never has to think about it.
The numbers the pages quote are in `packages/shared/src/plan.ts`; the prices Paddle charges
are in its catalog, and the two are changed together.

Every account starts with a fortnight's trial, no card asked for — counted from its first
request after billing is on, so an account that existed before the keys went on gets its
fortnight from then, not from the deploy. When it runs out, or a subscription lapses, the
account turns **inactive**: everything still opens, searches and
exports, and every write but a delete is refused with a 402 that the app shows as a
read-only banner. The same state, and the same code path, for an expired trial, a lapsed
subscription and a comp that ended (`requireActivePlan` in the API). After a year inactive
the account will be deleted, with reminders to export first; the job that does it and the
reminders are a follow-up to MAK-108, and the terms will say so with MAK-45.

Comps do not go through Paddle. A 100% discount there still asks for a card and charges it
when the discount ends, so an account that should not pay — the owner, a gifted friend — is
comped from the operator's page, with an end date or none, and Paddle never hears of it.
Paddle discount codes are for marketing.

Storage is enforced where bytes come in: an upload, a copy, a fetched picture or a
duplicate past the plan's quota is a 402 that names the numbers, and the Plan page shows
what the account holds against it. The sum is kept on each account's store by triggers
(schema 0008), never by reading the files table.

### Setting up Paddle

Sandbox and live are two separate Paddle accounts, with separate logins, keys, prices and
webhook secrets: [sandbox-vendors.paddle.com](https://sandbox-vendors.paddle.com) is for
building against, and needs no approval; [vendors.paddle.com](https://vendors.paddle.com)
is the real one, and its verification — the website review, the business and the
identity checks — takes days, so start it early. Everything below is done in both, the
sandbox first.

1. **Catalog → Products.** Two products: the plan, with one price of $36 a year, and
   the storage add-on, with one price of $12 a year and quantity turned on. The tax
   category is Standard Digital Goods, which needs no approval. Copy both price ids,
   `pri_…`.
2. **Developer tools → Authentication.** An API key with `customer`, `transaction` and
   `subscription` read and write and `customer_portal_session` write, which is shown
   once; and a client-side token, which is public and ships in the page.
3. **Checkout → Checkout configuration.** A default payment link — the homepage is fine,
   and `https://localhost/` in the sandbox — and the payment methods to offer. The
   checkout itself is Paddle's overlay on the Plan page, so no page of yours needs it.
4. **Developer tools → Notifications.** A destination of type webhook at
   `https://<host>/api/billing/webhook`, with the subscription events
   (`subscription.created`, `activated`, `trialing`, `updated`, `past_due`, `paused`,
   `resumed`, `canceled`) and `transaction.completed`. Its secret, `pdl_ntfset_…`, is
   what every delivery is signed with. The Worker answers inside Paddle's five seconds
   and applies each event once, in any order, so a retry or a late delivery changes
   nothing.
5. **The five settings** on the Worker, as secrets: `PADDLE_API_KEY`,
   `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PLAN_PRICE_ID` and
   `PADDLE_STORAGE_PRICE_ID`. Which environment they belong to is read off the key:
   `pdl_sdbx_` is the sandbox, `pdl_live_` is live. In `.dev.vars` locally; as the
   `DEV_PADDLE_*` GitHub secrets for the dev instance, which the deploy carries over with
   the sandbox's values; and on production by hand, `pnpm exec wrangler secret put` from
   `apps/api` for each, with the live account's. `APP_URL` must be set too, since the
   mail that says a plan has ended names it. That mail goes out from the hourly sweep
   through the same provider and allowance as the sign-in codes, so it is capped at two
   an hour (`LAPSE_MAIL_PER_RUN`): on Resend's free tier of a hundred a day, a cluster of
   trials ending together — every account that existed when billing went on starts its
   fortnight at its first visit — must not crowd the codes out. On a paid mail tier the
   cap can go up (MAK-220).

Locally, Paddle cannot reach a webhook on `localhost`; a tunnel (`cloudflared tunnel
--url http://localhost:<API_PORT>`) gives it an address for a session, or the sandbox's
simulator sends a sample event to one. The live suite proves the rest with a signed body
of its own (`apps/api/test/plan.test.ts`), given the dev server's secret and price ids as
`PADDLE_WEBHOOK_SECRET`, `PADDLE_PLAN_PRICE_ID` and `PADDLE_STORAGE_PRICE_ID` — the same
lines as `.dev.vars`. Test cards are in Paddle's sandbox docs; `4242 4242 4242 4242` with
any future date succeeds.

Going live is the same five settings from the live account, after its verification. The
website review wants the pricing public, and terms, a privacy policy and a refund policy
naming Paddle as the merchant of record, which the built-in documents do not yet say; that
is MAK-45 and MAK-46. Everything an account is told — the trial's end, a lapse, the mail —
is the same in both environments.

## Deleting an account

Settings → Maintenance, at the bottom, under everything else the page can destroy. The
button sends a confirmation link to the account's own address and deletes nothing by
itself; `POST /api/auth/delete-user` is the same thing without the page.

The link opens `/delete-account`, which asks once more and deletes on a POST when the
button there is pressed. It deliberately does not point at Better Auth's own
`/delete-user/callback`, which deletes on a bare GET: a GET is fired by link prefetches,
mail scanners, restored tabs and mistaps as readily as by people, and while a request with
no cookies fails, webmail read in the browser that holds the session is exactly the case
cookies do not cover. `/reset-password` has the same shape for the same reason — an emailed
token names an intention, and the click that acts on it should be a person's.

Pressing it sweeps `users/{id}/` out of R2, wipes the account's note store — the object
holding every note, tag, notebook, field and attachment record — and then removes the user
row, whose cascade takes the sessions. It does not touch the backups: the account's
dumps, its mirrored files and the D1 exports that name it age out on their own, every one
within about three months (see [Durability](#durability)), and neither the wind-back nor
the load route will put a deleted account back from them. Then it signs the browser out and lands on
`/goodbye`. The account's row in the directory is tombstoned last, and the sweep drops it
once the object reports itself empty and the user row is gone, retrying the wipe if it was
interrupted. The sign-out is not a formality: the
deleting request re-writes the session-cache cookie from the session it resolved on the way
in, so without it the browser would keep a five-minute claim to an account that no longer
exists.

A session on its own is deliberately not enough, and neither is a password. The session
token travels as `Authorization: Bearer` from the phone and the CLI, and this is the one
action in the app with no trash to fish anything back out of; owning the address is the one
proof every account type can give, whether it signed in with Google, a passkey or a
password. The link works once and expires in a day. Export first if you want anything.

Unlike **Delete all notes**, the confirm does not ask you to type `DELETE`. That gate
belongs to a button that *is* the irreversible step; this one only sends mail, and asking
for the word to send an email would be friction guarding nothing — and would teach the
habit of typing it unread on the page where the other control means it. The typed word is
not what is missing from the mail's end either: a second press is.

An instance with no mail configured does not offer the endpoint at all, since the
confirmation is the mechanism — the same test that decides codes by email. `/api/config`
reports it as `accountDeletion` alongside the sign-in methods, so the settings section is
simply absent there rather than drawing a control the server would answer with a 404. In
local development `sendEmail` prints the link to the Worker console instead of sending it,
which is how the flow is exercised without a Resend account.

If the R2 sweep or the store wipe fails, the deletion is abandoned rather than
half-finished: the account survives with attachment rows pointing at objects that are
already gone, or with an empty store, and the failure is logged with the user id. Asking
again is the fix. Blobs and store go before the row here, the reverse of `purge-notes`,
because the user id both need is exactly what the deletion destroys; blobs before the store
because the store's rows are what the blob sweep reads to know which objects are
referenced.

An operator can delete someone else's account from that account's page under Settings →
Operator, for a sign-up that should not exist — a bot, a test account, someone who asked
by other means. It is `DELETE /api/admin/accounts/<id>?confirm=<id>` — the id twice, so
neither a stray retry nor a hand-typed URL deletes anything — and it is the same deletion in
the same order, by the same code (`lib/account-deletion.ts`), with no email: the link is a
person's proof that an account is theirs, which is not what lets an operator act. The
confirm names the account and what is in it, and asks for `DELETE` typed, since here the
button is the irreversible step. The backups are left to age out as above. The operator's
own account is refused; that one is deleted here, with its link.

## Blob garbage collection

R2 has no foreign keys, so objects can outlive their metadata — a crash between the upload
and the metadata insert, or a store wiped without its prefix having been swept first.
`POST /api/admin/gc-blobs` reads every key the caller's note store references, sweeps the
caller's own prefix and reports what it finds; add `?apply=1` to delete. It is scoped to
`users/{caller}/` by design, so it can never see or remove another account's objects.

## Android app

The site, whole, in one WebView, with native code only for what a page cannot do on
Android: the share sheet, sign-in through the phone's account sheet, the file picker and
camera, saving into Downloads, links, and the app's own address and version.

It used to draw its own note list, filters, notebooks, trash and settings in Compose, with
only a note's body in a WebView. Every feature the site gained then had to be built twice,
and within a week the phone was missing bulk selection, auto-fill and half of what
Settings does. The site is held to a phone-layout standard anyway, so the app shows it. A
self-hosted instance serves the app the site that matches its API, and a change to the site
reaches the phone on deploy, with no store release.

```
cd apps/android
./gradlew test              # unit tests, no device needed
./gradlew installDebug      # build and install on a running emulator or device
```

The build needs a `local.properties` naming the SDK, which Android Studio writes for you:

```
sdk.dir=/Users/you/Library/Android/sdk
```

**How it signs in.** By whatever the instance offers, read from `GET /api/config`: Google
through Android's account sheet, GitHub through a Custom Tab to `/connect` that comes back
with a one-time token, or email and password against Better Auth directly. Every path ends
the same way: the session cookie the response set is stored per origin in app-private
preferences. Its value goes out as `Authorization: Bearer` from the app's own client, and
the same cookie is written into the WebView's jar before the site loads — one sign-in,
one session, nothing exchanged between the two. A Trusted Web Activity could never do
this, because Chrome's cookie jar is Chrome's; that is why the previous shell needed a
handoff on every launch. Signing out on the page tells the app, which forgets its copy and
shows its own sign-in. A page that believes the session has ended says so too, and the app
asks `/api/me` before believing it, because a phone with no signal looks the same to the
page; that case gets a native "couldn't reach" panel and keeps the session.

**How the site is hosted.** `MainActivity` is one WebView of the instance. The page sits
between the system bars, and the app paints the strips behind them in the page's own
colour, which the page reports; the keyboard shrinks the page, so the editor's toolbar sits
on the keys. A small bridge (`apps/web/src/app-bridge.ts`, `NoteBridge.kt`) carries
everything else. Back asks the page first, which closes an open sheet, then walks the
WebView's history, then puts the app in the background rather than finishing it, so an
upload in flight and the page's state survive. A notification's note opens in place
without reloading the site. The site's Settings shows an "App settings" pill only inside
the app, for the native screen that holds the instance address and version; the launcher
icon's long-press reaches it too.

Links off the site, `target=_blank` included, open in a Custom Tab. Attachment downloads
go to DownloadManager with the session added by hand, since it cannot see the WebView's
cookies. An export is built in the page (see [Backups and export](#backups-and-export))
and streamed to the app through the bridge's synchronous save calls, which write it into
Downloads as it arrives. A `blob:` download would reach the download manager as an address
only the page can read, and the export would silently save nothing. Links to the
instance's `/notes`, `/trash` and `/settings` open in the app through verified App Links,
rebased onto whichever instance the app points at; the rest of the host, `/connect` and
mailed links above all, stays in the browser.

**How a file is attached.** The Attach button is the editor's own, in its bar; what the
app adds is the file chooser behind it, since a WebView opens no picker of its own. It
offers the phone's file apps with the camera beside them, the way Chrome answers the same
input, and an input that asks for capture goes straight to the camera. The picker's files
go to the page as they are, under the picker's grant. A photo the camera takes is written
to the app's cache and handed over through a FileProvider, accepted by identity because the
chooser otherwise refuses this app's own provider. A HEIC photo is transcoded to JPEG on
the phone first, for the reason given under captures below.

**How a capture works.** Sharing to Unbent opens a sheet over the sending app with the
title, the notebook and the tags, prefilled so that the lazy case is one tap on Save. The
shared files are copied into the app's cache the moment the sheet opens — the URI
permission dies with the activity, so this cannot wait — which is also what lets someone
who is signed out sign in and come back to find the share still there. Save enqueues a
WorkManager job that creates one note, filed and tagged as the sheet said, and streams
each file to `PUT /api/notes/:id/files?link=1`. The `link=1` flag is what makes the server
append the markdown link to the note body, since the sheet has no cursor and no copy of
the body. Several files shared together become one note. A toast says "Saving" as the sheet
closes, and the capture's progress is a notification, since a toast cannot change or be
tapped: "Saving" with the note's title, then "Saved", which peeks over the screen and opens
the note in the app. HEIC images are transcoded to JPEG on the phone, because the server's inline-safe
allowlist excludes HEIC and browsers other than Safari cannot render it.

**How a capture becomes searchable.** A PDF gets a second job, chained after the upload:
it loads `/embed/index-files?note=…` in a WebView that is never shown, and the page runs
the same pdf.js extraction the site does, for that one note. Chained rather than folded
into the upload so a WebView failure can never re-run the upload and create the note
twice; photos have no text and skip it. When the server extracted the text itself as the
files landed, the upload says so and the second job ends without opening a WebView. If it
fails, the note is still saved and the file stays on the server's pending list, where the web
app's pass on open picks it up.

**Pointing it at a dev server.** On the sign-in screen, Change the address to
`http://10.0.2.2:5173` from an emulator; once signed in the same field is in App settings.
Cleartext is permitted for loopback addresses in debug builds only (see
`network_security_config.xml`), and the API trusts that origin in development (see
`baseURLFor` in `apps/api/src/auth.ts`).

**Release signing.** The keystore lives outside the repo. Point at it from
`apps/android/local.properties`:

```
unbent.keystore.path=/Users/you/.config/unbent/release.jks
unbent.keystore.password=…
unbent.key.alias=unbent
unbent.key.password=…
```

Absent those, `assembleRelease` still builds, just unsigned. CI reads the same values from
`UNBENT_KEYSTORE_PATH` and friends.

**Building it for your own instance.** Two more lines in the same file, neither of which
touches a tracked file:

```
unbent.defaultInstance=https://notes.example.com
unbent.applicationId=com.example.notes
```

The first is where the app signs in until someone changes it in App settings; unset, it is
`https://unbent.app`. Its host is also the one the app claims links on. The second is the identity Play, the Google OAuth client and the app
links document all key on, and a fork that publishes needs one of its own — Play will not
take a second app under an id it already has, and a reverse-domain id has to be one you
control. The Kotlin package stays `com.makerocketgonow.unbent` either way; only the id
changes, and `scripts/app-id.sh` prints what a build of this checkout gets. CI reads the
same two as the `ANDROID_DEFAULT_INSTANCE` and `ANDROID_APPLICATION_ID` repository
variables, and the Play upload publishes under the same id.

**Vouching for the app.** Android will only open this site's links in the app, and only
offer the site's passkeys to it, if the site says which app that is: a Digital Asset Links
document at `/.well-known/assetlinks.json` naming the package and the SHA-256 of every
certificate that signs it. The instance serves that document from its `ANDROID_ASSET_LINKS`
secret — the JSON verbatim, an array of statements — and an instance that has not set one
vouches for no app, which is right until you have one. The debug build is a different
package (`.debug`) and needs a statement of its own. Three keys usually sign a published
app, and all three belong in it: the debug keystore, the upload key, and the App Signing
key Play re-signs every bundle with, whose fingerprint is on the app's App signing page in
Play Console. Registering only the upload key is the classic trap, because every build you
can test locally then works and the store build does not.

```bash
cd apps/api
pnpm exec wrangler secret put ANDROID_ASSET_LINKS < assetlinks.json
```

The `ANDROID_ASSET_LINKS` repository secret carries the same document to the dev instance
and previews, so passkeys made there work from the app too.

## iOS app

The site, whole, in one web view, the way the Android app is, with native code only for
what a page cannot do on an iPhone: sign-in, saving files where the phone keeps them, links
that leave, and the app's own address and version. It is a port of the Android app's shell
rather than a second design, and where the two differ it is because the platforms do.
TestFlight is still to come.

```
swift test --package-path apps/ios/Packages/UnbentCore   # unit tests, on the Mac, no simulator
pnpm ios:build      # build, install and launch the debug build on a simulator
pnpm ios            # launch what is already installed
```

**How it is laid out.** `apps/ios/Unbent.xcodeproj` has two targets, the app and its Share
Extension, whose sources are the `Unbent/` and `UnbentShare/` folders as they are on disk,
with `Shared/` compiled into both; a file added to any of them needs no change to the
project. Two local Swift packages hold everything that is not the shell or a sheet of the
system's. `UnbentCore` is Foundation
only and builds for the Mac, which is what lets its tests run without a simulator: the
session cookie, where an address opens, the API, the Keychain store, the page's messages
and the files the app saves, each a port of the Kotlin one with its tests. `UnbentUI` is
the native screens as SwiftUI views that take values and closures, apart from the app so
the share extension can draw the same ones.

Every build setting is in `apps/ios/Config/` — `Base.xcconfig`, with `Debug.xcconfig` and
`Release.xcconfig` over it, and `Share.xcconfig` for what the extension's build differs
in — and the project file holds none. `Info.plist` reads them, and
`BuildInfo.swift` reads `Info.plist`. The plist is run through the C preprocessor for the
two blocks only the debug build has, which is why it has no DOCTYPE and no apostrophes: the
preprocessor takes `//` for a comment and a lone `'` for an unfinished character.

The debug build is a second app, as on Android: bundle id `.debug`, the name "Unbent
(debug)", an amber icon, and its own session and web data, so the two sit side by side.

**How it signs in.** By what the instance offers, read from `GET /api/config`. Two methods
are only requests: a code by email and a password, against Better Auth directly. Three put
one of the system's sheets first. Apple's, which returns an identity token bound to a
nonce: Apple is given the nonce's SHA-256 and the server the nonce itself, and the name
Apple sends on a first authorization is set on the account afterwards. The passkey sheet,
which signs the challenge from `/api/auth/passkey/generate-authenticate-options`; the
cookie that response sets names the challenge and is sent back with the answer by hand,
since the app's client keeps no cookie jar. And a browser at `/connect`
(`ASWebAuthenticationSession`, sharing Safari's cookies) for Google and for any other
provider the instance has, which comes back on `unbent://connect` with a one-time token —
the Android app's flow, and the same two redirect schemes, since a scheme belongs to one
platform's install. Google has no sheet of its own here: Google's SDK would be a
dependency that ends in a web sheet anyway. Passkeys need the app to claim the instance's
host (`webcredentials:` in `Config/Unbent.entitlements`) and the instance to vouch for the
app, below; the debug build claims `dev.unbent.app` too, in developer mode, and a dev
server on localhost cannot be claimed at all. Every path ends the same way as on Android:
the session cookie the response set is kept per origin, here in the Keychain under the App
Group so the share extension can read it, and is `AfterFirstUnlockThisDeviceOnly` — usable
while the phone is locked in a pocket, and never restored onto another phone. Its value
goes out as `Authorization: Bearer` from the app's own client, and the same cookie is put
into the web view's store before every load. `URLSession` hands a response's `Set-Cookie`
headers over joined into one, so they are split apart again before the session is looked
for; `SessionCookie.splitSetCookie` says why `HTTPCookie` is not used for that.

Signing out on the page tells the app, which forgets its copy and shows its own sign-in. A
page that believes the session has ended says so too, and the app asks `/api/me` before
believing it; a phone with no signal gets a native "Couldn't reach Unbent" panel and keeps
the session.

**How the site is hosted.** `WebShellController` is one `WKWebView` of the instance, and
the page has the whole screen. It did not at first: the page was held inside the safe
area with the strips above and below painted in its colour, as on Android, and on a phone
with a Dynamic Island those strips are tall enough that the drawer and its scrim stopped
short of both ends of the screen and read as a card between two bands. So inside the iOS
app the page asks for `viewport-fit=cover`, keeps its own content clear of the clock and
the home indicator with `env(safe-area-inset-*)` (the rules under `html.host-ios` in
`styles.css`), and tells the app it has done so; a page that has not said so, from an
older deploy, still gets the safe area and the strips. The drawer is square-cornered
there as well, since the rounded one is Material's shape and iOS side panels are not. The
status bar's text follows the lightness of the colour the page reports. The keyboard
shrinks the web view rather than covering it, so the editor's toolbar sits on the keys. The bridge is a script the app
injects before the page's own, which builds `window.UnbentApp` over WebKit's message
handlers — the object Android installs with `addJavascriptInterface` — so the page calls
either host the same way (`apps/web/src/app-bridge.ts`, `Bridge.swift`). There is no Back to
handle: the edge swipe walks the web view's history, and the page closes a sheet when the
history moves under it.

Links off the site, `target=_blank` included, open in a Safari sheet over the app; a new
window to the site itself opens in place, without reloading the page. Downloads run in the
web view's own session and are saved into the app's folder, which the Files app shows under
On My iPhone; an export is built in the page and streamed through the bridge's save calls,
each answered only once its bytes are written, which is what keeps a library larger than
memory from queueing there. Both are written to a hidden file and named once whole, and a
banner offers to open or share what was saved. `alert`, `confirm` and `prompt` are shown by
the app, because a web view left to itself answers `confirm()` with false and asks nobody.
The file picker and the camera need no code: WebKit presents its own for a file input, and
a photo chosen from the library arrives as a JPEG even when the phone took it as HEIC, so
the transcoding the Android app does by hand is not needed for those. A HEIC picked through
Choose Files is handed over as it is.

**Why a build opens one instance.** WebKit gives an app's web view a service worker — and
so the offline shell, see [Your library on the device](#your-library-on-the-device) — only
for the domains the app binds itself to, in `WKAppBoundDomains`, and a web view bound that
way can open nothing else. So a release build opens the instance it was built for and App
settings shows the address without a field; a self-hoster builds the app for their own
host, below. The debug build is
also bound to `dev.unbent.app` and `localhost`, and its App settings can switch among them.
With the instance stopped, the app relaunches into the note list from the service worker
and the local copy, with the page's own offline banner.

What the page stores survives relaunching the app and restarting the phone: the cookie,
the outbox in IndexedDB, and the library in the origin-private file system.
`navigator.storage.persist()` answers false in the web view, so that storage is the
system's to reclaim under pressure, like any app's caches; nothing the server has not heard
of is kept only there for long, since the outbox drains whenever there is a connection.

**How a capture is saved.** Sharing to Unbent from another app opens the extension's
sheet — title, notebook, tags, prefilled as on Android — over a copy of what was shared,
made in the App Group's container before the sheet has drawn (`CaptureStager`): what a
share hands over lasts only as long as the sheet. A HEIC with no JPEG offered beside it
is transcoded, since the server serves HEIC to nobody inline.

Nothing is uploaded by the extension, or by the app in the ordinary sense. iOS ends an
extension when its sheet closes and suspends the app seconds after it leaves the screen,
so every request is handed to a background `URLSession`, which the system sends whether or
not anything of the app's is running, launching the app in the background to hear each
result (`CaptureQueue`). A background session promises no order, so the requests go a stage
at a time: Save sends `POST /api/notes` and closes the sheet, and the files follow once
the note is known to exist. Each result is applied to the capture's record, `.job.json`
beside its files, by a pure function with the rules in it (`CaptureJob.handle`): four
tries with a backoff, and none for a 4xx that will be the same next time; a file given up
on is left out of a capture that is otherwise saved; a 503 with `Retry-After` waited
out, up to fourteen times, without spending a try; a 401 for the session the phone still
holds forgets the session and keeps the capture, which then waits for a sign-in like one
made signed out. A retry is a request created at once with `earliestBeginDate`, so the
wait is the system's to keep. The note's id is chosen on the phone, and each file's is
sent as `X-Attachment-Id`, which is what makes any of this safe to send twice. An app the
person force-quit is not relaunched for a result, so whatever is on disk is also looked
at on every launch and every return to the app.

The app has one background session; the extension has one per capture, named in the
capture's record, which the app joins to collect what the extension started. Only one
process may use a background session at a time, and a single shared name has a second
share contending with the app woken for the first.

Shared while signed out, a capture is staged all the same and sent after the next sign-in;
it waits thirty days for one, and the notification says so if it is given up on. A sheet
closed without Save or Cancel leaves no record, and its files go after three.
Its one notification goes from "Saving…" to "Saved" in place and opens the note; delivery
is asked for provisionally, so there is no prompt and the first one arrives quietly with
the system's own Keep or Turn Off. A PDF or an image can also be opened in the app from
another one ("Open in", Files, a scanner's app), which shows the same sheet over the same
queue. Captured PDFs are not indexed on the phone, as Android's are: the server's own
extraction covers unbent.app, and the site's pass when the note is opened covers the rest.

**What iOS does that Android does not.** It suspends an app seconds after it leaves the
screen, so the shell asks for a few seconds of background time for the page's save on
`visibilitychange` to reach the server. It ends the page's process under memory pressure
while the app lives on, which leaves a blank web view that says nothing; the shell is told,
drops any export that page was writing, and reloads the address it was on. And it can
empty the cookie store between two looks at the app, so the session is put back each time
the app comes forward as well as before each load.

**Pointing it at a dev server.** In the debug build, App settings takes
`http://localhost:<port>`; a simulator shares the Mac's loopback, so nothing like `adb
reverse` is needed. Plain http is allowed for local addresses in debug builds only
(`NSAllowsLocalNetworking`). Vite's port serves the site without its service worker; the
Worker's own port serves the built site with it, after `pnpm build`.

**Building it for your own instance.** Put the three things that are yours in
`apps/ios/Config/Local.xcconfig`, which is untracked and read last:

```
UNBENT_BUNDLE_ID_BASE = com.example.notes
UNBENT_INSTANCE_HOST = notes.example.com
DEVELOPMENT_TEAM = ABCDE12345
```

The first is the identity the App Store, the App Group and the site association document
all key on, and has to be a reverse-domain name you control. The second is the instance the
app opens and the one domain its web view is bound to; `UNBENT_INSTANCE_SCHEME` beside it
is `https` unless you say otherwise, and the two are apart because `//` begins a comment in
that file. The third signs a build for a phone; a simulator needs none. `MARKETING_VERSION`
and `CURRENT_PROJECT_VERSION` are the version and build number App settings shows.

**Links and quick actions.** A link to the instance's notes, trash or settings, tapped in
Mail, Messages or Safari, opens in the app (a universal link), at the same place on
whichever instance the app is pointed at. The app claims the host (`applinks:` in the
entitlements); which paths are the app's is the instance's to say, in the association
document below, and a link to a host the app is not pointed at now opens in Safari's sheet
over it. Held on the Home Screen, the icon offers New note and App settings. New note opens
`/notes?new=1`, which the site answers as its New button: it makes an unfiled note and
replaces the address, so Back and a reload do not make another. The debug build claims
`dev.unbent.app` in developer mode, which a simulator always is, so
`xcrun simctl openurl booted https://dev.unbent.app/notes/<id>` tries it; the first link
after an install can still open in Safari, while the system is fetching the document.

A store build cannot do either for an instance of your own: universal links and passkeys
offered by the system both go to the host the build claims, and the store build claims
unbent.app. Build your own, as above, with `UNBENT_INSTANCE_HOST` set to your host, and serve
an association document naming it.

**Vouching for the app.** iOS opens this site's links in the app (universal links), and
offers the site's passkeys to it, only if the site says which app that is: an Apple App
Site Association document at `/.well-known/apple-app-site-association`, naming each app by
its team id and bundle id. The instance serves it from its `APPLE_APP_SITE_ASSOCIATION`
secret — the JSON verbatim, an object rather than Android's array — and an instance that
has not set one vouches for no app. The team id is on the Apple Developer portal's
Membership page; the debug build is a different bundle id (`.debug`) and is listed beside
the release one.

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["TEAMID.com.example.notes", "TEAMID.com.example.notes.debug"],
        "components": [
          { "/": "/connect", "exclude": true },
          { "/": "/api/*", "exclude": true },
          { "/": "/notes" }, { "/": "/notes/*" },
          { "/": "/trash" }, { "/": "/trash/*" },
          { "/": "/settings" }, { "/": "/settings/*" }
        ]
      }
    ]
  },
  "webcredentials": {
    "apps": ["TEAMID.com.example.notes", "TEAMID.com.example.notes.debug"]
  }
}
```

The paths are the Android app's: the pages, never the sign-in flow or files. The first
component that matches wins, so the exclusions come first, and `/notes/*` rather than
`/notes*` keeps a path that merely starts with the word from being claimed.

```bash
cd apps/api
pnpm exec wrangler secret put APPLE_APP_SITE_ASSOCIATION < apple-app-site-association.json
```

Apple's CDN fetches the document, not the phone, so it has to reach the Worker from a
datacenter: a zone with Bot Fight Mode on needs a WAF skip for `/.well-known/` paths, or
the CDN is served a challenge. `https://app-site-association.cdn-apple.com/a/v1/<your
host>` shows what Apple has. The `APPLE_APP_SITE_ASSOCIATION` repository secret carries the
same document to the dev instance and previews.

**Sign in with Apple from the app.** The app signs in natively and posts Apple's identity
token to `/api/auth/sign-in/social`, as the Android app does with Google's. That token's
audience is the app's bundle id, not the Services ID the web button uses, so an instance
accepts it only for the bundle ids in `APPLE_BUNDLE_ID` — comma-separated, the release and
the debug build both, since either may be pointed at any instance:

```bash
echo "com.example.notes,com.example.notes.debug" | pnpm exec wrangler secret put APPLE_BUNDLE_ID
```

It is read only while Apple is configured for the web too (see [Sign in with
Apple](#sign-in-with-apple)): the Services ID is still accepted beside it, and an instance
without `APPLE_CLIENT_ID` offers Apple to nobody. Both App IDs need the Sign in with Apple
capability on the portal.

## Known gaps

- **Connected apps get all-or-nothing access.** Approving an MCP client grants every tool
  it offers; there is no way to connect one read-only. Scopes exist in the protocol and are
  advertised, but nothing enforces a narrower grant yet, and a consent screen offering a
  choice nobody can act on would be worse than the honest sentence it shows instead.

## Where your notes live

Each account's notes are in a database of their own: a SQLite-backed Durable Object per
user, `UserStore` in `apps/api/src/store/`, holding that account's notes, tags, notebooks,
fields, attachment rows and search indexes and nothing else. D1 keeps what is shared across
accounts — sign-in, connected apps, upload links, and a directory of accounts — and R2
keeps the files. The reasons are in the decision record on the issue that started this; the
short one is that the app's partition is absolute (no sharing, no cross-account read
anywhere), and when the natural partition is the user and each partition is tens of
megabytes, one SQLite per user is the shape the primitive was built for. Requests get
faster, since every statement after the first call runs in-process; restore becomes per
account rather than per instance; and the multi-device sync that is planned next wants
exactly one writer per user.

The Worker authenticates and forwards. `requireAuth` runs there; `reposFor` binds the
request to the session's own object, and every route, MCP tool, export page and import then
reads and writes through it. Five rules hold the shape, and tests hold the rules:

1. **The object touches its SQLite and nothing else.** No outbound call inside it: R2 bytes,
   the language model, the auto-fill API and mail all happen in the Worker before or after
   the call. Blob *keys* go through the object, which owns the attachment rows; bytes never
   do.
2. **Ids stay globally unique UUIDs** even inside a per-user database, so `(owner, id)` is
   unambiguous forever and an archive imported into two accounts keeps its ids in both.
3. **The owner's object is the source of truth.** If sharing ever comes, a grantee reads
   and writes through the owner's object.
4. **The change feed is per user, with a sequence cursor.** Never a global one.
5. **Each call to the object is a billable request.** A route asks once for what it needs,
   through composite methods, rather than two or three times.

**The cutover** (September 2026) copied every account's rows out of the shared D1 tables
into its store, verified each table's count against what D1 held, and then dropped the
tables: migration 0036, guarded so it refuses to run while any account with rows is not
recorded as copied. The directory's `migrated_at` and `copied_at` are its record — when
each account's rows were frozen against writes during the deploy, and when they were
verified copied. The copy, the freeze that protected the rows, and the operator's route for
it are in the history of MakeRocketGoNow/unbent#202; nothing in the code reads D1 for notes
any more, and there is no way back to the shared tables. Restoring an account is per
account: to a moment in the last thirty days, or from its dump (below).

**Schema changes** are files in `apps/api/src/store/schema/`, applied per object on its next
wake, additive only. The sweep is what makes that safe to rely on: it wakes every object —
twenty an hour, from a cursor it keeps in D1, since every store call counts against an
invocation's fifty subrequests on Free — so a migration that fails for one account fails in
the log with the user id on it. Each visit reads a few rows of the account (its size and
the stored note counts), never a table. The deploy runs a whole pass as its last step, when
the repository has a `SWEEP_TOKEN` secret: `scripts/sweep-stores.mjs` sends the token in
place of a session, starts the walk from the top rather than from the cron's cursor, calls
the sweep until it is done, and fails the deploy if any account's
store did not wake. Without the secret the step skips and the cron gets there within the
day.

**Daily dumps.** Where a backups bucket is bound as `BACKUPS`, the same cron at :47 dumps
every account whose store has changed into it, as `stores/<user>/<YYYY-MM-DD>.sql` — the
file `GET …/dump` below writes. An account is tried once a day; it is dumped when its change
feed has moved since its last dump, and in any case once that dump is a week old, so a
bucket whose lifecycle rule deletes dumps after fourteen days always holds one of every
account. A big store is read in several calls, so a write can land partway; such a dump
says so in its last lines, and the account is dumped again the next day. The account directory records each one's last dump, and every run writes
`status/dumps.json` to the bucket: what it did, and which accounts failed or have gone
forty-eight hours without a dump found current. Nothing is bound at the top level of
`wrangler.toml`, so a fork's instance never dumps; unbent.app's production deploy binds the
bucket its `BACKUPS_BUCKET` repository variable names, and the dev instance binds
`unbent-dev-backups`. A run keeps to fifty subrequests, the Free plan's, which caps a dump
near 170 MB of SQL; an account past that is recorded as failed rather than dumped, and
is tried again each day after every other account, which spends that run's budget. On
Workers Free a large account may not finish a scheduled dump well before that, since a
run's CPU time is limited too. A self-hoster arranges their own backups.

**Nightly mirror.** unbent.app keeps a copy of all of it in a second Cloudflare account,
pulled from outside by `.github/workflows/mirror.yml` each night at 05:23 UTC with
`rclone`: the live files bucket to `blobs/`, the dumps bucket's `stores/` to `stores/`, and
a `wrangler d1 export` to `d1/<date>.sql`. Those three prefixes are under a thirty-day
retention lock in that account, so nothing can overwrite or delete a copy younger than
that, and lifecycle rules delete dumps and D1 exports after ninety days. Files are pruned
by the workflow instead: a key in the mirror and not in live is gone, the date it was
first seen gone is written to `state/prune.json`, and its copy is deleted once it has been
gone fifty-five days (`scripts/mirror/prune-plan.mjs`, a pure function with a test; a
live listing that comes back empty fails the run rather than planning against it). The
run then reads the Worker's `status/dumps.json` and fails if a dump failed, an account has
no dump found current in forty-eight hours, or the status is older than that, so the
Worker's half of the backup fails loudly too; and it writes `status/mirror.json` back to
the dumps bucket — when it ran, what it copied and pruned, the export's size — for the
operator's page. It runs only where the repository has the nine secrets in the
[configuration table](#everything-you-can-set) and the `BACKUPS_BUCKET` variable, read-only on the
live bucket, and skips itself otherwise; a fork names its live and mirror buckets at the top
of the file. The first copy, and any rerun, is
started by hand from the Actions tab.

**Putting files back.** `.github/workflows/restore-files.yml` copies one account's files
from the mirror back into the live bucket: started by hand only, from the Actions tab,
with the account id and the word `RESTORE` typed in; anything else in that box is a dry
run that lists the counts and copies nothing. It is the one workflow that can write to
the live bucket, with a credential of its own (`RESTORE_R2_ACCESS_KEY_ID` and
`RESTORE_R2_SECRET_ACCESS_KEY`, in the `restore` GitHub environment, which only a
workflow on `main` may use — that rule on the environment is what keeps an edited copy
of the file on a branch away from a key that can delete from the live bucket).
`rclone copy --ignore-existing` is the whole of what it does: nothing
is deleted and nothing already in the live bucket is overwritten, so running it twice is
the same as once, and it never writes to the mirror, so the prune's state file is left
alone — the files reappearing in live are enough for the next night's prune to forget
their gone-dates. The run's summary has counts; the files' names stay out of it.

**Losing the whole Cloudflare account.** Everything above is in one account but the
mirror, and this is how the mirror is turned back into an instance. Expected loss: up to
a day of notes, since the newest dump is from the last 00:47 UTC and the mirror copied
it at 05:23; files uploaded since that night's copy; and every store's thirty days of
history, with its undo bookmarks. Files deleted in the fifty-five days before are still
in the mirror and come back as orphans the file sweep reclaims.

1. A new Cloudflare account, with the same names: the Worker, a D1 database, and the
   buckets `wrangler.toml` and the mirror workflow name (`unbent-blobs`,
   `unbent-backups`). Point the domain at it.
2. Create the database and import the newest `d1/<date>.sql` from the mirror, after
   putting its schema first: `node scripts/mirror/order-d1-export.mjs d1.sql ordered.sql`,
   then `wrangler d1 execute <name> --remote --file ordered.sql`. The export as written
   puts every index after all the rows, and a fresh database refuses the first row whose
   foreign key points at a column one of those indexes makes unique — a "foreign key
   mismatch" that D1's import reports only as `{"D1_RESET_DO":true}`, with nothing
   imported. The script exits non-zero if the export holds a statement it does not
   know; read what it says before importing. Then deploy: every migration is recorded
   in the export, so the deploy's migration step applies nothing, and the
   Worker's secrets come from the password manager, which is the one place they are
   kept — `BETTER_AUTH_SECRET` above all, or every session is lost with it and everyone
   signs in again. If that secret is gone too, deploy with a new one and then
   `wrangler d1 execute <name> --remote --command "DELETE FROM jwks"`: the export
   carries Better Auth's signing key encrypted with the old secret, and until the row is
   gone every session read is a 500 (`Failed to decrypt private key` in the Worker's
   log) behind a sign-in form that never goes away. Better Auth makes a new key on the
   next request. The sessions were lost with the secret either way; passkeys survive,
   since a passkey is a public key in the database and the secret only signs the
   challenge it answers.
3. Copy the files back: `rclone copy mirror:unbent-mirror/blobs/ live:unbent-blobs/`
   from a laptop with the mirror's credential and a write key for the new bucket, or
   the restore-files workflow once per account.
4. Copy the dumps back to where the load route reads:
   `rclone copy mirror:unbent-mirror/stores/ dumps:unbent-backups/stores/`.
5. For each account in the directory (`SELECT user_id FROM account_directory WHERE
   deleted_at IS NULL`), `POST …/load` with the newest dump under `stores/<id>/`. The
   object is empty on a new account, so there is nothing to dump first and nothing to
   undo to; the load's own dump of it is a few kilobytes.
6. New R2 tokens and GitHub secrets for the mirror and the restore workflow, since the
   old account's are gone with it, and a hand-started run of the mirror to prove the
   new account is being copied.

**The change feed.** Every write records what it touched, numbered by the store's own
counter, and `GET /api/changes?since=N` answers "what changed since N?" with the changed
notes whole — body, tags, values, files — the changed notebooks and tags, and a tombstone
for anything purged. A device with no copy yet walks the whole library through
`GET /api/changes/snapshot`, then follows the feed from the counter the first page
reported. `GET /api/changes/socket` is the push: a WebSocket the store tells the counter
on after every write, held through the platform's hibernation so an idle device costs
nothing; the feed is complete without it. The feed keeps ninety days or fifty thousand
rows; a cursor older than that, or from before a restore, is answered with `reset` and
the device starts over from a snapshot. This is what the local copy of the library in the
browser syncs from; see [Your library on the device](#your-library-on-the-device).

**What the operator can see.** An object has no console, so the Worker has one, under
`/api/admin/store` for a session in `OPERATOR_EMAILS`:

- `GET …/stats` — row counts, size and schema version, the caller's own or `?user=`'s. A
  name the directory does not have is refused, since a store is created for any name it
  is asked for.
- `POST …/sql` — one `SELECT` (or `EXPLAIN`) against a store, always rolled back.
- `GET …/dump` — the store as SQL text, `sqlite3 account.db < dump.sql` rebuilds it: what
  `d1 export` was, and how a migration is rehearsed against a real account before it
  ships — dump, load, run the new schema file's SQL against the copy. The daily dumps
  (above) are the same file.
- `POST …/restore` — winds one store back to a moment in the last thirty days; see below.
- `POST …/load` — replaces one store with a dump from the backups bucket; see below.
- `POST …/feed-epoch` — makes every device of an account resync its local copy, by
  naming a new history for its change feed. The restore does this itself.
- `POST …/sweep` — one batch of the walk, now; `?restart=1` on the first call starts from
  the top of the directory, then call without it until it says `done`. Also open to the
  deploy, with the deployment's `SWEEP_TOKEN` in an `X-Unbent-Sweep-Token` header instead of
  a session.

Reading another account's store is logged with both ids. Rows read and written inside an
object are metered as D1's were, and every statement over a threshold is logged with the
user id — which is the accounting `wrangler d1 insights` used to give.

**Winding a store back.** Every store keeps thirty days of history, and `POST …/restore`
puts one back as it was at a moment in them — the rollback for a schema file that broke an
account, or an edit that should not have happened. It is for one account at a time and
the operator only; moving notes between accounts or instances is export and import. A
deleted account is refused: its wipe is part of the history, and winding back past it
would bring back notes its owner asked to have removed.

1. `GET …/dump?user=<id>` and keep the file. It is the copy that outlives the thirty days.
2. `POST …/restore` with `{ "user": "<id>", "at": "2026-09-30T12:00:00Z" }`. Without
   `confirm` this is a dry run: it says which bookmark the time resolves to, refuses one
   outside the window, and shows the store as it is now.
3. Repeat with `"confirm": "RESTORE"`. The store restarts to apply it, and the answer has
   the restored store's counts and an `undo` bookmark — the store as it was the instant
   before. `{ "user": "<id>", "bookmark": "<undo>", "confirm": "RESTORE" }` reverses it.
   Every restore and load is also kept in D1 (the `restores` table) with the operator who
   asked, and the operator page lists them under the wind-back form. It offers Undo on the
   newest only: an older one's bookmark is from before everything after it. The Worker's
   log has each bookmark as well.

The whole database goes back together, schema version included, so a restore to before a
schema file is migrated again on the next wake. Files are in R2, not the store, and are
not wound back, but they follow it: a file deleted since the restored moment is still in
the bucket, because a deleted file's object stays for thirty-five days under a tombstone
the store keeps (see [Deleting notes](#deleting-notes)), and the restore winds that
tombstone back with the row, so the file is simply the note's again. The five days past the
thirty of history are the margin for a restore to the oldest moment it can reach. One
uploaded since the restored moment is an orphan, which the account's own
[file sweep](#deleting-an-account) reclaims. Local development has no
history to restore from — Miniflare refuses, and the route answers 501 — so a restore is
tried on a preview of a PR that touches `src/store/`, which has stores of its own.

**Loading a dump.** A fault noticed after the thirty days, or a store that is simply
gone, is put back from a dump: `POST …/load` with `{ "user": "<id>", "dump": "2026-10-06" }`
names that day's daily dump in the backups bucket, and `"dump": "stores/<id>/<file>.sql"`
names any other file under the account's own prefix — the one written before an earlier
load, or one copied back by hand from the mirror. A dump can only be loaded into the
account it was taken from. Without `confirm` it is a dry run: whose the file is, when it
was taken, whether its rows are one moment of the store or were read while it was being
written to (the file's last lines say), and the store as it is now. With
`"confirm": "LOAD"`:

1. The store as it stands is dumped first, to `stores/<id>/<time>-before-load.sql` beside
   the daily dumps, where the nightly mirror copies it off-account; the answer names it
   as `before`.
2. The object takes a bookmark of itself (`undo` in the answer; the restore route winds
   back to it in one call for thirty days), empties itself, and marks itself loading.
   From that moment until the load is whole the store refuses every request with a 503
   and `Retry-After`, the same answer any passing unavailability gets, so a half-loaded
   store is never read as an empty one. The mark is in storage, so it holds across an
   eviction.
3. The file is streamed into the object in pages, each run in one transaction with
   foreign keys off, as `sqlite3` would load it; a row too long to run as one statement
   (a long body, a file's text) runs with its values bound.
4. The object checks that the dump's `_meta.user_id` is its own and that its schema
   files are ones this code knows, applies any the dump lacked (a dump from before a
   schema file loads at the current version, not the dump's), names a new feed epoch so
   every device starts over from a snapshot, and only then clears the mark.

A failure after step 2 leaves the store refusing, and the answer says so with both ways
out: restore to `undo`, or load `before`; calling again starts over. Files are not in
the dump and are not touched: a file the dump's rows name is still in the bucket if it
was deleted less than thirty-five days before, since the dump carries the store's
tombstones for it; one deleted longer ago is gone from the live bucket, and comes back
from the mirror (below). A file uploaded after the dump was taken is an orphan the
account's own [file sweep](#deleting-an-account) reclaims. The answer counts rows whose
parent the dump does not hold, which a dump read mid-write can have.

**Where an object lives.** The platform creates each account's object near the first
request for it, and objects do not move. `STORE_JURISDICTION=eu` keeps every store in the
EU, for an operator whose users need that. It is decided once, before the instance's first
account, and never changed: the jurisdiction is part of how a store is found, so the same
account names a different, empty object with it set than without, and changing it on a
running instance would make every account's notes vanish from view.

**Deleting an account** wipes its object; see [Deleting an account](#deleting-an-account).
Locally, the objects are files under `.wrangler/state/v3/do/`, which `sqlite3` opens, and
the reset scripts clear them with the database they belong to.

What does not change: notes are Markdown with frontmatter, export is the same folder tree,
and a restore is an import.

## Tenant isolation

Notes are isolated by construction: each account's are in a database of their own, and no
query can name another account's rows because no such rows exist where the query runs.
`reposFor` in `apps/api/src/lib/repos.ts` binds a request to the session's own object, and
the object refuses on every wake a database whose stored owner is not the user it was
created for. Route handlers never reach for a store or for `env.DB` themselves; a static
test in `apps/api/src/store/guards.test.ts` holds that line.

What stays in D1 — sessions, OAuth clients, upload links, the account directory — has no
row-level security, so for those tables isolation is still application code: the scoped
repos in `apps/api/src/lib/repo.ts` take the user id as a constructor argument, and an
unscoped query is not expressible from a route. `apps/api/test/isolation.test.ts` asserts
all of this from outside and grows with every phase that adds a route touching user data.
The MCP endpoint's cases live beside it in `apps/api/test/mcp.test.ts`, which needs a whole
OAuth flow before it can call anything and would otherwise swamp the suite it belongs to.

One route finds its user another way. `PUT /api/uploads/:token`, the other half of
`prepare_attachment_upload`, is authorized by the token in its path and nothing else. The
token is looked up once, deleted as it is read, and yields the user id the scoped repos are
then built from, exactly as a session does everywhere else. Its cases are in `mcp.test.ts`
too, since only the tool can mint one.

## Durability

What unbent.app promises about keeping your notes, stated as what is true on `main` today
and nothing further. The mechanics are in [Where your notes live](#where-your-notes-live);
the customer-facing version is the privacy policy's "How long it is kept" and the
deletion page, both of which say this only on an instance that keeps backups
(`backups` in `/api/config`, true where a `BACKUPS` bucket is bound). A fork with no
bucket makes no dumps and has no mirror — the first two rows of the table still hold —
and its documents describe only that. The Worker cannot see whether the mirror workflow
runs, so a fork that binds a bucket and never sets the mirror up has its documents
overstate the off-account half; such a fork should publish its own, as `legal/documents.ts`
says of every operator the built-in text does not fit.

**What is kept, and where.** Each account's notes are in a store of their own on
Cloudflare, its files in R2 and the account records in D1, all in one Cloudflare
account. Beyond the live copy:

| Copy | Where | Kept |
| -- | -- | -- |
| The store's own history, for winding back | Cloudflare, in the store | 30 days |
| A deleted file's bytes, under a tombstone the store keeps | The live bucket | 35 days |
| A daily dump of every account whose store changed, and of every account at least weekly | A backups bucket in the same account | 14 days |
| Those dumps, copied nightly | A second Cloudflare account | 90 days |
| Every file, copied nightly | The second account | Until 55 days after the file leaves the live bucket |
| The D1 export: sign-in, connected apps, the account directory | The second account | 90 days |

The nightly copy is made by a GitHub Actions job on a GitHub-hosted runner, pulling from
outside with a read-only credential: **your files pass through that runner on the way to
the second account**, and none of your content is kept on it. The copies in the second
account sit under a thirty-day retention lock, so the credential the job uses, or a
leaked copy of it, cannot overwrite or delete one younger than that; an administrator of
that account can still change the rule, or close the account, which is what the two
accounts being separate is for. Worker secrets are in no backup. The mirror has run on
its schedule once, on 7 October 2026, green; it has not yet shown a week of nights, which
is what MAK-171 asks for before it closes.

**What a deletion means.** Emptying the trash removes a note's rows at once and its files
thirty-five days later; a deleted account's files go at once. Neither touches the
backups, which age out on their own: a dump fourteen days after it was written
on-account and ninety days after the night it was copied off-account, a file fifty-five
days after the night it was first seen gone from the live bucket, a D1 export ninety days
after its night. The last copy of a note purged today is therefore the dump written this
morning, copied tonight, deleted ninety days on — **a deleted note or a deleted account is
gone from every copy within about three months**, ninety-one or ninety-two days at the
longest, which the customer-facing text rounds to "about three months" rather than
promising a number the lifecycle rule can miss by a day. A note's history is in the dumps
too, so **Clear history** is final once they have aged out, not before.

**What each way back loses.** Nothing here is a merge; each puts an account back as it
was at some moment and loses what came after.

- *Winding the store back*, to a moment in the last thirty days: everything written after
  that moment, and nothing else — files follow the store through their tombstones, so a
  file deleted since is the note's again. Reversible for thirty days by the undo bookmark.
- *Loading a dump*, for a fault noticed too late to wind back: everything since the dump
  was taken, which is up to a day; the store's thirty days of history and its undo
  bookmarks; and the live copy of a file deleted more than thirty-five days before the
  dump, which comes back from the mirror by the restore-files workflow. Reversible for
  thirty days by the store's bookmark, and the store as it stood is dumped first.
- *Losing the whole Cloudflare account*, the runbook under Where your notes live: about
  a day of notes, and more if the account is lost after the morning's dump and before the
  night's copy of it; every file uploaded since the night's copy; every store's history;
  and every session, so everyone signs in again. Files deleted in the fifty-five days
  before should come back as orphans the sweep reclaims; that part was not rehearsed.

None of these is a way to bring one note back. That is the trash, History in a note's
⋯ menu, and the [export](#backups-and-export) in your own hands.

**What has been rehearsed, and what has only been dry-run.** On the dev instance on
7 October 2026, with counts checked before and after: notes purged and a file deleted,
the store wound back to the minute between and the files serving their bytes again; the
undo of that, both as a wind-back by time and by the bookmark; a day-old dump loaded, with
the before-load dump listed, and that load undone; and steps 1 to 5 of the whole-account
runbook into a scratch Worker in the second account, with the dumps loading to counts
identical to dev. On 8 October, restore-files for real: a throwaway account's one file,
copied to the mirror by a hand-started mirror run, deleted from the live bucket by hand,
and put back by the workflow with `RESTORE` — one file in the mirror, one copied, byte
for byte the object that was deleted. Dry-run only: the runbook's step 6, new credentials
for a new account and a hand-started mirror, which is designed and not proven. The
write-ups are on MAK-171 and MAK-200.

## Backups and export

Settings → Export writes a zip of the whole account as a plain folder tree:

```
first-note-2382e420/first-note-2382e420.md
first-note-2382e420/files/agenda.pdf
first-note-2382e420/files/whiteboard.jpg
first-note-2382e420/text/agenda.pdf.txt
first-note-2382e420/described/whiteboard.jpg.txt
untitled-e080eb5b/untitled-e080eb5b.md
notebooks/coupons.yaml
```

Each markdown file carries YAML frontmatter — id, title, created, updated, tags, notebook,
and any custom field values by name — above the body exactly as written. The directory name
is a slug plus an id fragment, so two notes with the same title do not collide, and the
markdown repeats it so a search of the unpacked tree finds one file per title rather than a
thousand `note.md`s. Standard `unzip` reads it; no part of this app is needed to get your
notes back.

Beside `files/`, `text/`, `described/` and `written/` hold the text this instance holds for each
file, as a plain `<filename>.txt`: `text/` for what the file's own text layer gave,
`described/` for what the vision model read from a picture or a scan with no layer,
`written/` for what an assistant recorded over MCP after reading the picture itself. A file
with no text has none. They are what makes a scanned bill answerable, so they are also
what a person would want to `grep` in the unpacked folder — and without them a restore read
every file again, a PDF extraction or a paid vision request per file, and got different
words than search and Auto-fill had been built on.

`notebooks/` holds what is about a notebook rather than a note: one `<slug>.yaml` per
notebook with its emoji and its purpose when it has them — the purpose is what Auto-fill
files by, so a restore without it files differently — and its fields in order, each with its type and, where it has them, its select
or multi-select options, its rating scale or its currency. A multi-select's value is a YAML list under the
field's name, the way `tags` is. A value in frontmatter says nothing about the field that holds it,
and without this file a restore rebuilt every field from the first value it met — URLs and
selects as text, ratings as plain numbers, and a field with no values not at all. An
unfiltered export lists every notebook, empty ones included; a filtered export lists the
notebooks its notes are in, plus the one the filter named.

The browser builds the archive. `GET /api/export/notes` hands back a page of whole notes
— body, tags, fields, and the names of their files — and the web app walks its cursor,
fetches each file through the note's own file route, and writes the zip with the names and
markdown that `packages/shared/src/export-format.ts` defines. It used to be one request
that streamed the whole zip, and that request read every note and every file from the
Worker as it went; a Worker request may make only so many calls to storage (a thousand on
Workers Free), and a library is tens of thousands of them, so the backup could never have
finished on the archive it existed for. In Chrome and Edge the zip streams straight to a
file the person chooses, so a library larger than the tab's memory still exports; other
browsers hold it in memory and hand it over as a download when it is done.

The page endpoint takes the note list's `tag`, `notebook`, `field`, `from`, and `to`, so an
export can be a slice rather than the whole library — a year of records for a doctor, the
receipts an accountant asked for. Settings → Notebooks offers the `notebook` slice as a
download beside each notebook, since "a copy of this notebook" is the slice people reach
for, and the note list offers the filter on screen beneath its filters. The enumeration
goes through the same `notes.list` as the list itself, so a filter cannot mean one thing on
screen and another in the zip. There is no order (a directory tree has no order worth
choosing); `sort` is accepted only to say which column a date range applies to. The filename
carries the scope, since several slices land in one downloads folder on the same day.

This is the backup in your own hands, not a convenience feature. It used to be the only
copy anywhere that held both the notes and their files; since October 2026 unbent.app's
daily dumps and nightly mirror hold both as well (see [Durability](#durability)), but
those are the operator's, for a fault on the service's side, and they age out, so the
export is still the only copy a person holds and the only one that works on any
instance. An account's store dump (see [Where your notes live](#where-your-notes-live))
has no files in it, and D1 has held no notes since the cutover. `wrangler d1 export`
works on D1 again, but what it exports is
sign-in, connected apps, upload links and the account directory. It used to refuse the
whole database because of the search tables, which have since moved into each account's
store, and a refused export left D1 answering every query with "processing export"
([workers-sdk#9519](https://github.com/cloudflare/workers-sdk/issues/9519)). So never put a
virtual table — FTS5 or any other — back in D1.

### Restoring, or moving to another Unbent

The same zip goes back in through Settings → Import, on the instance that wrote it or any
other — as does a single note's download, zip or bare `.md`. Every note's metadata is in its
own frontmatter, so a notebook exported with `?notebook=` arrives as that notebook, with its
tags, dates, custom fields and files; nothing about the notes lives outside the archive.

The `notebooks/` files are applied first, through `POST /api/import/notebook`, so values
land against the definitions they were written under. The rule there is add, never alter: a
field the notebook lacks is created as the file describes it, a field it already has keeps
its type and scale (changing either clears values, which an import should not decide), and
a select's or multi-select's options are merged. A notebook's emoji and purpose are set
when it has none and otherwise kept. A note's value naming an option the field
lacks adds that option rather than being dropped, so a vault with no `notebooks/` file still
lands with its choices intact. Anything left unapplied is named in the import's failure log.
An archive without `notebooks/` — an older export, a hand-made vault — imports as before,
with each field's type inferred from its first value. A single note's download carries no
definitions, since it is not a notebook.

Each note keeps the id it had when the id is free, so a restore puts notes back at their old
addresses and links between them keep working. A note that is already present — by id, or
by content hash for archives without ids — is skipped, so restoring a backup over a live
library duplicates nothing and never overwrites an edit made since. The trash is not
consulted: a note deleted on purpose stays deleted, and importing it again brings back a
fresh live copy under a new id.

The archive is read in the browser, one note and one attachment at a time, by the same
worker that reads ENEX files — the requests, the resumability and the per-note failure log
are all the ENEX import's. Attachment types are recovered from the bytes and then the
extension, since a zip carries neither. A file that arrives with a `text/`, `described/` or
`written/` sidecar is uploaded with `?text=supplied`, which stops the Worker reading it, and its text is
recorded as it was, under the reader that wrote it; nothing is extracted, nothing goes back
to pending, and no vision request is made. A file without one — from an older export — is
read as any upload is, so search works after that restore too. Only the layout is assumed: markdown with frontmatter, and a `files/` directory
beside it. Directory names are ignored, so an archive unpacked, rearranged and zipped again
by hand reads the same as the original.

### Importing from Notion

Notion's "Markdown & CSV" export — of a workspace, or of one database or page — goes in
through the same Settings → Import. The zip is read before anything is imported, and the
panel lists what it holds: one row per top-level database or page, with its notes, files
and columns counted, to tick or untick. The usual reason to untick is a database that is
already here from another source; the two Evernote-migrated notebooks in a real export
would otherwise arrive twice, since a note from Notion and the same note from ENEX share
no id and no hash.

Each database becomes a notebook, its rows the notes, and its columns the notebook's
fields. Notion's CSV carries no types, so each column's is inferred from every value it
holds, conservatively: Yes/No is a checkbox, a run of stars a rating, `$29.99` a number in
USD, short values that repeat a select, comma-separated parts that repeat a multi-select,
and anything the rules cannot place is text, which the Fields page can convert. A column
named Tags becomes the note's tags (an option under the list keeps it as a field), and
Notion's own created and last-edited columns become the note's dates — the one place the
export carries a timestamp; every other note is dated at import. A text column too long
for a field goes into the body under its own heading. Formulas and rollups are not in the
CSV and are dropped.

A page and its sub-pages become a notebook too, with any database nested in the tree
adding its columns; pages outside any database or tree go into one notebook named in the
panel, or none. Every page keeps Notion's id as its note id — the 32 digits are a UUID
without its dashes — so importing the same zip again skips what landed, and links between
exported pages, relative or `notion.so`, become links between the notes. Attachments sit
in a folder named for their page and are uploaded as the note's files; callouts become
quotes. The driver is `importNotion` in `packages/enex`, beside the ENEX and archive
importers, and shares their requests, resumability and failure log.

## License

[Functional Source License, Version 1.1, Apache 2.0 Future License](LICENSE.md)
(`FSL-1.1-Apache-2.0`). The whole repository, mobile apps included, is under it.

What it permits: run Unbent for yourself, your family, or your own company; read, modify,
and redistribute the source; build the apps from it. What it forbids: offering Unbent, or
something substantially like it, to others as a commercial product or service that competes
with the software or with unbent.app. That is the one restriction, and it is what keeps the
hosted service viable while the code stays public.

Two years after each release, that release becomes available under Apache 2.0. The
conversion is irrevocable and written into the license text, so the code cannot be locked up
for good and the [export guarantee](#backups-and-export) does not depend on trusting anyone.

Contributions are accepted under the same terms; see [CONTRIBUTING.md](CONTRIBUTING.md).
