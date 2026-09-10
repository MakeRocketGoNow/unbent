# Unbent

A personal note app that keeps your notes in Markdown and hands them back whenever you ask.

Notes are Markdown with YAML frontmatter. Attachments are ordinary files. Export produces a
plain folder tree — one directory per note, containing `note.md` and a `files/` subdirectory —
that you can read, grep, and back up without this app existing.

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
- **Cloudflare D1** (SQLite) — note text, metadata, FTS5 full-text search
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
than on Workers, and export streams the zip as the client consumes it.

## Layout

```
apps/web       Vite + React SPA
apps/api       Hono API on Workers, and the MCP server under src/mcp
apps/android   Kotlin app: native shell and share sheet, the web editor in a WebView
packages/shared  zod schemas, frontmatter codec, remark plugins
packages/enex    ENEX -> Markdown, runtime-agnostic
```

`apps/android` is a Gradle project, not a pnpm workspace package: `pnpm -r` skips it, and it
is built with its own wrapper. See [Android app](#android-app).

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
`local.properties`), installs, and seeds the worktree's local D1 and R2 with a copy of the
main checkout's — so the same notes are there, and because the session cookie on localhost
is host-only and ports do not scope cookies, the browser arrives already signed in. The
copy is a snapshot: the two databases drift apart from then on, which is the point, since a
branch's migrations must not reach the main checkout's schema. `--fresh` starts empty
instead.

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
| `APP_URL` | pinning one origin | see [Your own domain](#your-own-domain); also a GitHub secret the deploy carries |
| `OPERATOR_NAME`, `OPERATOR_EMAIL` | the built-in privacy policy and terms | both or neither; see [Who runs this instance](#who-runs-this-instance) |
| `LEGAL_PRIVACY_URL`, `LEGAL_TERMS_URL` | legal pages hosted elsewhere | both or neither; win over the built-in ones |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | codes by email, password reset | the first two or neither; see [Choosing sign-in methods](#choosing-sign-in-methods) |
| `<PROVIDER>_CLIENT_ID`, `<PROVIDER>_CLIENT_SECRET` | any of Better Auth's OAuth providers | both or neither; the callback is `/api/auth/callback/<provider>` on your origin |
| `AUTH_PASSWORD`, `AUTH_PASSKEY` | forcing a method on or off | rarely needed; the defaults are explained in the sign-in section |
| `POSTHOG_KEY`, `POSTHOG_HOST` | error tracking | see [Errors in the browser](#errors-in-the-browser) |
| `ANDROID_ASSET_LINKS` | an Android build of your own | see [Android app](#android-app) |
| Custom domain | serving from your own name | dashboard, not config |
| `ANDROID_APPLICATION_ID`, `ANDROID_DEFAULT_INSTANCE` | the Android build in CI | GitHub repository **variables**; `unbent.applicationId` and `unbent.defaultInstance` in `local.properties` locally |
| `CLOUDFLARE_WORKERS_SUBDOMAIN`, `DEV_BETTER_AUTH_SECRET`, `DEV_ALLOWED_EMAILS` | a dev instance and PR previews of your own | GitHub; see [The dev instance](#the-dev-instance) — every job skips itself without them |

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

It exists because of the Android app. The editor there is this site in a WebView, so a
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
uses, so it is a second window onto the same scratch data rather than a fourth environment
with data of its own.

It exists because a preview cannot be a stable host, and several things need one:

- **OAuth.** A callback URL cannot be registered against a hostname that changes every PR.
- **Passkeys.** `auth.ts` derives the `rpID` from `APP_URL`, so one enrolled on a preview is
  useless on the next.
- **Mail.** A reset or sign-in link is only worth sending to a host that will still be there
  when the message is opened.
- **The Android app.** `DEFAULT_INSTANCE` is `https://unbent.app`, and the Settings override
  had nothing to point at that was neither production nor gone by morning.

Before it, production was the only instance anywhere with a hostname stable enough to prove
a sign-in flow against — which is a poor place to find out that one does not work.

It is not staging, and should not be treated as one. Nothing in it is backed up, every
preview writes to the same database, and a PR's migration lands there before the PR merges
— so the dev instance can be briefly wrong for the code `main` is running. That is the same
sharp edge previews have, with the same fix.

Unlike a preview it carries the `ai` binding, so it extracts a PDF's text on the server as
production does. An instance is only worth having if the path it exercises is production's,
and extraction is the half of an import that differs most between the two.

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

To point the Android app at it, put the host in Settings; `Prefs.instance` is per-origin, so
the production session is kept rather than overwritten.

### Preview deployments

Every pull request that touches the web app or the API gets a URL of its own —
`https://unbent-pr-<N>.<subdomain>.workers.dev` — where the branch can be used rather than
read. `.github/workflows/previews.yml` deploys it on each push to the PR and deletes it when the
PR closes, and posts the URL both as a comment it edits in place and as a deployment in the
PR's own Deployments box.

A preview is a whole Worker, not a static copy of the SPA, because one Worker serves both
halves and `auth.ts` derives its baseURL, trusted origins, cookie security and passkey
`rpID` from `APP_URL`. Cloudflare's own preview URLs share the production bindings, so a
preview built on them would run against the production database with `APP_URL` still
reading `https://unbent.app`, and refuse every sign-in from the preview host as an invalid
origin. That is why the Worker and its `APP_URL` are per PR.

The data underneath is not. All previews share the `unbent-dev` D1 and the
`unbent-dev-blobs` bucket, configured as `[env.preview]` in `apps/api/wrangler.toml` and
served with a stable hostname by [the dev instance](#the-dev-instance) above — kept well
away from production but not from each other. It is a scratch environment: notes made on
one PR's preview are visible from another's and from `dev.unbent.app`, and nothing in it is
backed up.

The environment is called `preview` rather than `dev` because the custom domain cannot live
in a block previews reuse: `--name` changes which script a deploy targets but not which
hostname it claims, so a route here would be taken over by whichever preview deployed last.

Sign-in on a preview is a password and an allowlisted address. That is not a special case
but the default any instance falls back to with no OAuth and no mail configured, as
["Choosing sign-in methods"](#choosing-sign-in-methods) describes. OAuth is not offered
because a callback URL cannot be registered for a host that changes with every PR. Passkeys
work, each bound to the one preview host it was created on. Both are what the dev instance
is for — same data, hostname that stays put.

Migrations are the sharp edge. A PR that adds one applies it to the shared database on its
first preview deploy, and nothing rolls it back when the PR is abandoned. Wrangler tracks
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

The subdomain is a variable rather than a secret because the workflow has to build the URL
before deploying — `APP_URL` is baked in at deploy time — and a masked value would arrive
in the PR comment as `***`.

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

Then deploy again so the Worker picks up the secrets. `custom_domain = true` means
Cloudflare creates and manages the DNS record and certificate, so there is nothing to add
by hand:

```bash
pnpm release
```

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
consent screen, and approving it hands the client a token of its own. Fifteen tools are
offered — search and list, read a note in full, create, edit, tag, move, trash and restore,
plus notebook management. Note bodies are Markdown and pass whole in both directions, so an
assistant writes a complete note in one call.

Two are worth knowing about:

- **`edit_note`** takes `append`, `prepend`, or `replace` with an exact `find` string, so
  changing one line of a long note does not mean resending it. A `find` matching more than
  once is refused with the count rather than guessed at.
- **`get_attachment_text`** returns the text already extracted from a PDF, which is what
  makes a scanned bill answerable. See [Searching inside PDFs](#searching-inside-pdfs).

**Approving a client gives it standing access to everything.** It can read every note,
create and change notes, and move them to the trash, from then on and without asking again.
Settings › Connected apps lists what is connected and disconnects any of it; disconnecting
deletes the app's tokens, and the endpoint checks the grant on every call, so access ends
rather than lingering until a token expires. There is deliberately no tool that deletes
permanently — the trash is as far as an assistant can go.

Client registration is open, because clients register themselves at connect time and there
is no way to pre-provision credentials for software you have never heard of. A registered
client with no approved consent can read nothing; the registration endpoint is rate limited
so the table cannot grow quickly.

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
"Index existing PDFs" in the Import panel is where that gets run.

**Backfill.** Import is idempotent on content hash, so notes imported before extraction
existed cannot be fixed by re-importing — they are skipped along with their attachments.
"Index existing PDFs" walks the gap instead, extracting text for any attachment that does
not have it yet. `GET /api/attachments/pending-text` says what is still missing, scoped to
one note with `?note=`, which is how the phone asks for its own capture and nothing else.

## Local database

`pnpm --filter @unbent/api db:reset` rebuilds the local D1 from migrations, copying the
current state into `.wrangler/backups/` first. Use it instead of removing the state
directory by hand — that has no undo and has already cost one set of local notes.

## Deleting notes

Note deletion in the app is a soft delete — the note goes to trash and its attachments stay
in R2 so a restore is not left with dead links. To reclaim that storage, the Import panel
has a Maintenance section:

- **Empty trash** — permanently deletes soft-deleted notes and their files.
- **Sweep orphaned files** — removes R2 objects with no attachment row. Files you
  unlinked from a note still have a row; delete those from the note’s Attachments list.
- **Delete all notes** — wipes every note and attachment in the account. Requires typing
  `DELETE`, since it is irreversible and export is the only way back.

The API equivalents are `POST /api/admin/purge-notes?scope=trashed|all&confirm=DELETE` and
`POST /api/admin/gc-blobs?apply=1`. Both are scoped to the caller's own data.

For local development, `pnpm --filter @unbent/api reset:local` clears D1 and R2 entirely and
rebuilds the schema, backing up D1 first. Use that rather than the in-app sweep to clear
fixtures left by deleted test users — the scoped sweep cannot reach another account's
prefix by design.

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

Pressing it removes the user row, cascading away every note, tag, notebook and attachment
record, after sweeping `users/{id}/` out of R2, which no foreign key would have done. Then
it signs the browser out and lands on `/goodbye`. The sign-out is not a formality: the
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

If the R2 sweep fails, the deletion is abandoned rather than half-finished: the account
survives with attachment rows pointing at objects that are already gone, and the failure is
logged with the user id. Asking again is the fix. Blobs go before rows here, the reverse of
`purge-notes`, because the user id the sweep needs is exactly what the deletion destroys.

## Blob garbage collection

R2 has no foreign keys, so objects can outlive their metadata — a crash between the upload
and the metadata insert, or a user row cascading away its attachment rows without its
prefix having been swept first. `POST /api/admin/gc-blobs` sweeps the caller's own prefix
and reports what it finds; add `?apply=1` to delete. It is scoped to `users/{caller}/` by
design, so it can never see or remove another account's objects.

## Android app

A native app around the site's own editor. The note list, the note's title and filing,
settings and the share sheet are Kotlin and Compose; a note's body is the web editor at
`/embed/notes/:id`, rendered in a WebView. That is the same CodeMirror code the site runs,
so editing behaves identically in both places, and a self-hosted instance serves the app
the editor that matches its API.

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
the same cookie is written into the WebView's jar before the editor loads — one sign-in,
one session, nothing exchanged between the two. A Trusted Web Activity could never do
this, because Chrome's cookie jar is Chrome's; that is why the previous shell needed a
handoff on every launch.

**How a note is edited.** The app draws the title, notebook and tags natively and saves
them itself; the page saves the body. `PATCH /api/notes/:id` is partial, so the two never
overwrite each other. A small bridge (`apps/web/src/app-bridge.ts`) carries the page's
save state and its count of uploads in flight to the app, and lets the app ask the page
to flush — or to abandon those uploads first — before the screen closes.

**How a file is attached.** The Attach button is the editor's own, in its bar; what the
app adds is the file chooser behind it, since a WebView opens no picker of its own. The
system picker's files go to the page as they are, under the picker's grant. A HEIC photo
is transcoded to JPEG on the phone first, for the reason given under captures below, and
handed back through a FileProvider. Pressing Back with a file still uploading asks first:
leaving anyway drops the upload and its placeholder rather than saving the placeholder
into the note, which is what would otherwise happen, since the WebView that could have
replaced it dies with the screen.

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
`http://10.0.2.2:5173` from an emulator; once signed in the same field is in Settings.
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

The first is where the app signs in until someone changes it in Settings; unset, it is
`https://unbent.app`. The second is the identity Play, the Google OAuth client and the app
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
vouches for no app, which is right until you have one. Three keys usually sign a published
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

## Known gaps

- **Connected apps get all-or-nothing access.** Approving an MCP client grants every tool
  it offers; there is no way to connect one read-only. Scopes exist in the protocol and are
  advertised, but nothing enforces a narrower grant yet, and a consent screen offering a
  choice nobody can act on would be worse than the honest sentence it shows instead.

- **iOS has no share extension yet.** Safari does not implement Web Share Target, so an iOS
  capture needs a real share extension and a paid Apple Developer account.

## Tenant isolation

D1 has no row-level security, so isolation is application code and nothing else. Data access
goes through the scoped repos in `apps/api/src/lib/repo.ts`, which take the user id as a
constructor argument — route handlers never touch `env.DB` directly, so an unscoped query is
not expressible. `apps/api/test/isolation.test.ts` asserts this and grows with every phase
that adds a route touching user data. The MCP endpoint's cases live beside it in
`apps/api/test/mcp.test.ts`, which needs a whole OAuth flow before it can call anything and
would otherwise swamp the suite it belongs to.

## Backups and export

`GET /api/export` streams a zip of the whole account as a plain folder tree:

```
first-note-2382e420/note.md
untitled-e080eb5b/note.md
```

Each `note.md` is markdown with YAML frontmatter (id, title, created, updated, tags). The
directory name is a slug plus an id fragment, so two notes with the same title do not
collide. Standard `unzip` reads it; no part of this app is needed to get your notes back.

`/api/export` also takes the note list's `tag`, `notebook`, `from`, and `to`, so an export
can be a slice rather than the whole library — a year of records for a doctor, the receipts
an accountant asked for. The enumeration goes through the same `notes.list` as the list
itself, so a filter cannot mean one thing on screen and another in the zip. There is no
`sort` (a directory tree has no order worth choosing) and no `limit` (a partial backup is a
trap); `sort` is accepted only to say which column a date range applies to. The filename
carries the scope, since several slices land in one downloads folder on the same day.

This is the backup mechanism, not a convenience feature: `wrangler d1 export` fails on any
database containing an FTS5 table and leaves the database wedged in a "processing export"
state ([workers-sdk#9519](https://github.com/cloudflare/workers-sdk/issues/9519)). Do not
run it.

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
