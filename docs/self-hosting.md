# Self-hosting

## Running your own instance

Unbent is one Cloudflare Worker serving the site and the API, and the top level of
`apps/api/wrangler.toml` is that Worker, the same file whether the instance is unbent.app
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
bucket, asks for the two things every instance has to decide (an auth secret and who may
sign in, the uncommented lines of `apps/api/.dev.vars.example`) and deploys. From then on
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
non-zero when something required is missing, which makes it a status page for an instance
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
of `apps/api`, not a global install: the lockfile pins the version the config is known to
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
| `TYPESAFE_API_KEY` | filing a note from what it says | names TypeSafe in the built-in privacy policy, with what a press sends it, and asks every account to agree to that; see [Filing a note from what it says](search.md#filing-a-note-from-what-it-says); `DEV_TYPESAFE_API_KEY` as a GitHub secret carries a separate key to the dev instance and previews |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Auto-fill's language model: reading a note's pictures and text-less scans on a press, and writing its title and text fields | names Anthropic in the built-in privacy policy too, where `TYPESAFE_API_KEY` is also set (without it no press runs); see [Reading images](search.md#reading-images); `DEV_ANTHROPIC_API_KEY` as a GitHub secret carries a separate key to the dev instance and previews |
| `ANTHROPIC_READ_MODEL`, `ANTHROPIC_TITLE_MODEL`, `ANTHROPIC_FIELDS_MODEL`, `ANTHROPIC_READ_EFFORT` | a model per job, and the reading's effort | each unset falls back to `ANTHROPIC_MODEL`; see [Reading images](search.md#reading-images) |
| `AUTOFILL_DAILY_CAP` | a ceiling on Auto-fill presses per account per UTC day | a whole number; unset means none. Every press and the model's tokens are counted either way, and Maintenance shows the year's; see [Filing a note from what it says](search.md#filing-a-note-from-what-it-says) |
| `AUTOFILL_TRIAL_DAILY_CAP` | the same ceiling for an account on its trial | a whole number; unset means the trial gets `AUTOFILL_DAILY_CAP`. Only read where the plan is sold; set it smaller, since a trial is free to make; see [Selling the plan](billing.md#selling-the-plan) |
| `AUTOFILL_YEARLY_CENTS` | a ceiling on what one account's Auto-fill may cost per calendar year | whole cents; unset means none. Summed at each press from the tokens the counter records, at the prices in `packages/shared/src/llm-prices.ts`; see [Selling the plan](billing.md#selling-the-plan) |
| `AUTOFILL_TRIAL_YEARLY_CENTS` | the same ceiling for an account on its trial | whole cents; unset means the trial gets `AUTOFILL_YEARLY_CENTS`. Only read where the plan is sold |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PLAN_PRICE_ID`, `PADDLE_STORAGE_PRICE_ID` | selling the plan through Paddle | all five or none; unset, every account is active for good and nothing about billing is drawn. unbent.app's own, so leave them unset on yours. `DEV_PADDLE_*` as GitHub secrets carry the sandbox's to the dev instance; see [Selling the plan](billing.md#selling-the-plan) |
| `ANDROID_ASSET_LINKS` | an Android build of your own | see [Android app](android.md#android-app) |
| `APPLE_APP_SITE_ASSOCIATION` | an iOS build of your own | see [iOS app](ios.md#ios-app) |
| `APPLE_BUNDLE_ID` | Sign in with Apple from an iOS build of your own | comma-separated bundle ids, beside `APPLE_CLIENT_ID`; see [iOS app](ios.md#ios-app) |
| `SWEEP_TOKEN` | sweeping the note stores at the end of each deploy | a GitHub secret the deploy carries to the Worker, `openssl rand -hex 32`; see [Where your notes live](architecture.md#where-your-notes-live). `DEV_SWEEP_TOKEN` does the same for the dev instance |
| Custom domain | serving from your own name | dashboard, not config |
| `UNBENT_BUNDLE_ID_BASE`, `UNBENT_INSTANCE_HOST`, `DEVELOPMENT_TEAM` | an iOS build of your own | `apps/ios/Config/Local.xcconfig`, untracked; see [iOS app](ios.md#ios-app) |
| `ANDROID_APPLICATION_ID`, `ANDROID_DEFAULT_INSTANCE` | the Android build in CI | GitHub repository **variables**; `unbent.applicationId` and `unbent.defaultInstance` in `local.properties` locally |
| `CLOUDFLARE_WORKERS_SUBDOMAIN`, `DEV_BETTER_AUTH_SECRET`, `DEV_ALLOWED_EMAILS` | a dev instance and PR previews of your own | GitHub; see [The dev instance](#the-dev-instance); every job skips itself without them |
| `RESTORE_R2_ACCESS_KEY_ID`, `RESTORE_R2_SECRET_ACCESS_KEY` | putting one account's files back from the mirror | GitHub secrets in the `restore` environment, read-write on the live bucket, with the environment restricted to deployments from `main`; see [Where your notes live](architecture.md#where-your-notes-live); the run refuses without them |
| `LIVE_R2_ACCOUNT_ID`, `LIVE_R2_ACCESS_KEY_ID`, `LIVE_R2_SECRET_ACCESS_KEY`, `DUMPS_R2_ACCESS_KEY_ID`, `DUMPS_R2_SECRET_ACCESS_KEY`, `MIRROR_R2_ACCOUNT_ID`, `MIRROR_R2_ACCESS_KEY_ID`, `MIRROR_R2_SECRET_ACCESS_KEY`, `D1_EXPORT_API_TOKEN` | the nightly mirror to a second Cloudflare account | GitHub secrets, with `BACKUPS_BUCKET` as a variable; the live key read-only, the R2 keys scoped to one bucket each, the D1 token D1 Read and Edit on the account, since the export endpoint refuses Read alone and needs no bucket; see [Where your notes live](architecture.md#where-your-notes-live); the job skips itself without them |

The one thing that *would* work by accident is who the legal documents name: a fork that
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
external URLs win over the built-in documents when both are set: an operator who published
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
server holds the same line for the two ways a program gets a credential of its own:
approving an OAuth client and approving a CLI's device code, which are refused to an
account that has not agreed, however they are called. Connections that already exist keep
working.

Moving `LEGAL_VERSION` in `packages/shared/src/legal.ts` asks everyone again, worded as an
update, with `LEGAL_CHANGE` beside it to say what changed. Move it for a change worth
interrupting people for, not for every correction: the documents' effective dates move for
those on their own. A change only to the payment terms (`billingOnly`) moves it only where
the instance sells a plan; everywhere else those sections are not published, so nothing
changed and nobody is asked. An operator with their own documents sets `LEGAL_VERSION` in the
environment instead, since only they know when those change; unset, everyone is asked once,
and a change to the built-in documents never asks them again.

Set them per deployment rather than in `wrangler.toml`, which everyone who self-hosts
checks out:

```bash
cd apps/api
pnpm exec wrangler secret put OPERATOR_NAME
pnpm exec wrangler secret put OPERATOR_EMAIL
```

Neither value is confidential (both are printed on a public page), but set them as
secrets all the same, from here or as the Secret type in the dashboard. A plain text
variable added in the dashboard is gone after the next deploy, which replaces plain
variables with the file's; a secret is kept. What matters otherwise is only that they stay
out of the file a fork inherits.

Pull-request previews show the front page too, and a price with no terms beside it is not
what ships, so they take the pair from the `PREVIEW_OPERATOR_NAME` and
`PREVIEW_OPERATOR_EMAIL` repository variables (`previews.yml` passes them with `--var`).
Both or neither; unset, a preview publishes no documents. Variables rather than lines in
`wrangler.toml`'s preview environment for the same reason as above: a fork that runs
previews of its own would otherwise publish this repository's operator on them.

### Page statistics

Cloudflare Web Analytics, which is free, sets no cookie and assigns no identifier: the
reason the privacy policy can describe it as aggregate and anonymous and still promise
nothing follows you between sites.

There is nothing in this repo to configure it. Cloudflare injects the beacon itself, from
Web Analytics in the dashboard, under the site's Real User Measurements setting.

That is deliberate rather than the path of least resistance. Injecting it ourselves (a
build-time token, a Vite plugin, a GitHub secret) was written and then thrown away, because
the dashboard offers **Enable, excluding visitor data in the EU**, which skips the beacon
entirely for visitors from the EU. A tag in our own `index.html` cannot do that; it would
load for everyone and leave us arguing that cookieless analytics needs no consent. Not
collecting it at all is the better answer, and it costs a setting rather than code.

The trade is that European visitors are missing from the numbers, and that the setting lives
in the dashboard where nothing here can see it: a beacon that stops appearing is a change
somebody made there, not a regression to look for in a build. Both are worth it for having
no token to lose.

Content blockers stop the beacon too, so treat all of this as "which pages get used" rather
than as a count of anybody.

### Errors in the browser

A thrown exception in the page POSTs itself to `/api/client-errors`, which logs one line
into the Worker's own logs: `wrangler tail` live, or Workers Logs in the dashboard, where
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
first-party log stays unconditional either way: it is the one destination that works with
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

The token is public and write-only (it ships in the page) and is a secret here only to
keep one fewer credential in a repository people fork. `POSTHOG_HOST` sets the region;
unset means PostHog's US cloud, and the hosts the SDK needs are derived from it.

Two things to set in the PostHog project, neither of which this repository can do for you:

- **Cookieless server hash mode**, under Project settings → Web analytics. `cookieless_mode`
  needs it; with it off, events are dropped server-side and nothing in the browser says so.
- **Discard client IP data**, if you want it. Worth checking against the cookieless hash,
  which is computed from the address at ingestion: confirm in the UI that the two coexist
  before relying on both, and say what is true in the policy either way.

Reports travel through `/ingest/*` on this origin rather than to `posthog.com`, because a
request to that host is on every blocklist there is and the people running a blocker are
disproportionately the ones whose bug reports are worth the most. See
`apps/api/src/routes/ingest.ts`, and note that the path needs its `run_worker_first` entry
in every environment or the SPA fallback answers it with `index.html`.

Source maps are uploaded on release, without which every stack reads
`index-CDkkheec.js:1:48213`. That needs `POSTHOG_CLI_API_KEY` and `POSTHOG_CLI_PROJECT_ID`
as GitHub secrets (or exported locally before `pnpm release`) and is skipped silently
when they are absent.

The free tier is 100,000 exceptions a month and stops rather than bills. The reporter's own
cap of five per page load is what keeps a bad deploy inside that: a render loop is five
reports, not five thousand.

`release` rather than `deploy` because bare `pnpm deploy` is a built-in pnpm command that
shadows any script of that name; a `deploy` script does exist, migrations then release, for
deploy flows that look for one by that name, and is reached as `pnpm run deploy`. The first
deploy has to happen before the secrets below: they attach to a Worker, and `wrangler secret
put` fails until one exists, which is why the very first one carries `BETTER_AUTH_SECRET`
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
development and useless in production: anyone who forgets a password would have no way
back to their notes.

`ALLOWED_EMAILS` is what keeps a public URL from becoming a free notes host: without it,
anyone who can satisfy any enabled sign-in method can create an account. It is a secret
rather than a var only to keep the address list out of the repo. Leaving it empty is
allowed (an instance is not locked to its operator) but a deployed Worker with no
allowlist warns in its log, naming what a stranger could sign up with.

An instance that means to be public says so with `PUBLIC_SIGNUPS=1`, which silences that
warning and nothing else:

```bash
pnpm exec wrangler secret put PUBLIC_SIGNUPS       # 1, to mean it
```

It opens nothing (an empty `ALLOWED_EMAILS` has already done that), so this is a record of
a decision rather than a switch. Without it the warning cannot tell an instance that chose
to be public from one that forgot its allowlist, and on the first of those it becomes a
recurring line about something already settled, which is how a log line stops being read.

### The dev instance

`https://dev.unbent.app` is one standing Worker, `unbent-dev`, deployed from `main` by
`.github/workflows/previews.yml` and configured as `[env.dev]` in `apps/api/wrangler.toml`.
It runs on the `unbent-dev` D1 and the `unbent-dev-blobs` bucket that every preview also
uses, so accounts, sessions and files are one scratch set across all of them, and the
previews bind its note stores too (see [Preview deployments](#preview-deployments)), so a
note is one set across all of them as well. `pnpm seed:demo` is local only: it signs up a
password written into the script, so there is no seeding either of them; they hold
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
a sign-in flow against, which is a poor place to find out that one does not work.

It is not staging, and should not be treated as one. Nothing in it is backed up, every
preview writes to the same control-plane database, and a PR's D1 migration lands there
before the PR merges, so the dev instance can be briefly wrong for the code `main` is
running. That is the same sharp edge previews have, with the same fix. A change to the note
store's schema has no such edge: it is applied per object, on each object's next wake,
by whichever Worker owns the object.

Unlike a preview it carries the `ai` binding, so it extracts a PDF's text on the server as
production does. An instance is only worth having if the path it exercises is production's,
and extraction is the half of an import that differs most between the two.

#### Google on the dev instance

The [preview sign-in relay](#preview-deployments) bounces to the dev instance for OAuth, so
the relay is only useful if the dev instance can sign in with Google. Two `DEV_GOOGLE_*`
repository secrets configure it, mapped to the plain `GOOGLE_*` names the Worker reads: the
`DEV_` prefix so the dev instance can use a separate OAuth client from production, the way
`DEV_BETTER_AUTH_SECRET` already does. Both or neither: a lone client id with no secret is
not a working provider, so the deploy sends them only as a pair.

The OAuth client, whichever one these secrets name, has to list the dev instance, since a
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
| a record already existing for `dev` | something else in the zone owns that name: delete it in the dashboard and redeploy |
| the zone not being found | `unbent.app` is on another account, or another registrar entirely |

If the zone is not on Cloudflare, or you would rather wrangler did not touch DNS: delete the
`[[env.dev.routes]]` block, set `workers_dev = true`, and point `APP_URL` at
`https://unbent-dev.<subdomain>.workers.dev`. A standing Worker's workers.dev URL is stable
too, so OAuth, passkeys and mail all still work against it: only the name is uglier.

To point the Android app at it, put the host in App settings; `Prefs.instance` is per-origin,
so the production session is kept rather than overwritten, and switching back finds it.

### Preview deployments

Every pull request that touches the web app or the API gets a URL of its own,
`https://unbent-pr-<N>.<subdomain>.workers.dev`, where the branch can be used rather than
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
instance](#the-dev-instance) above, kept well away from production but not from each
other. Accounts, sessions and notes made on one preview are therefore on every other and on
`dev.unbent.app`. It is a scratch environment, and nothing in it is backed up.

The stores are shared by binding the `UserStore` class the `unbent-dev` Worker exports,
and a Durable Object runs the code of the Worker that exports it, so a preview reading
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
cannot run OAuth itself, but it does not have to. Its login screen shows **Continue on the
dev instance**, which sends the browser to `dev.unbent.app`, signs in there with Google (or
whatever the dev instance offers), and comes back with a one-time token the preview redeems
for a session of its own. It works because a preview and the dev instance share the
`unbent-dev` database, so a session minted on one is valid on the other, and because the
token is handed only to a host that matches `unbent-pr-<N>.<subdomain>.workers.dev` on the
configured subdomain: the check in `apps/api/src/lib/preview-relay.ts`, which is why the
dev deploy is given `PREVIEW_RELAY_SUBDOMAIN` and the preview deploy `PREVIEW_RELAY_ORIGIN`.

The session is shared rather than copied: redeeming the token sets the *dev instance's own*
session token as the preview's cookie, so the two hold one session between them. Signing out
on either signs you out of both, and the preview's session expires when dev's does. That is
a fair trade for a scratch environment, but it is surprising the first time it happens.

A password with an allowlisted address still works too (the default any instance falls
back to, as ["Choosing sign-in methods"](#choosing-sign-in-methods) describes), as do
passkeys, each bound to the one preview host it was created on. The relay is the fast path;
these are the ones that need no round trip.

D1 migrations are the sharp edge. A PR that adds one applies it to the shared database on
its first preview deploy, and nothing rolls it back when the PR is abandoned. Wrangler tracks
what it has applied by filename, so the stale file is simply never reconsidered, but its
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
| `PREVIEW_OPERATOR_NAME`, `PREVIEW_OPERATOR_EMAIL` | variable, optional | who runs the previews, sent as their `OPERATOR_NAME` and `OPERATOR_EMAIL`, so their front page has the built-in terms and privacy policy beside its price; both or neither, and unset a preview publishes no documents; see [Who runs this instance](#who-runs-this-instance) |
| `DEV_GOOGLE_CLIENT_ID`, `DEV_GOOGLE_CLIENT_SECRET` | secret, optional | Google on the dev instance, so the relay can sign in with it; both or neither, and the client must list `dev.unbent.app`; see [Google on the dev instance](#google-on-the-dev-instance) |
| `DEV_TYPESAFE_API_KEY` | secret, optional | Auto-fill on the dev instance and every preview; a key of its own, so what they spend stays apart from production's; see [Filing a note from what it says](search.md#filing-a-note-from-what-it-says) |
| `DEV_ANTHROPIC_API_KEY` | secret, optional | Auto-fill's language model on the dev instance and every preview; a key of its own, for the same reason; see [Reading images](search.md#reading-images) |
| `DEV_OPERATOR_EMAILS` | secret, optional | who is an operator on the dev instance and every preview, sent as their `OPERATOR_EMAILS`. Not implied by `DEV_ALLOWED_EMAILS`; unset, nobody is, and anything operator-only cannot be tried outside production. Removing it later leaves the dev instance's last list in place until `wrangler secret delete OPERATOR_EMAILS --env dev` |
| `DEV_SWEEP_TOKEN` | secret, optional | the dev instance's `SWEEP_TOKEN`, so its deploy ends with a sweep of its note stores as production's does; its own value, not production's. Previews get none and never sweep |

The subdomain is a variable rather than a secret because the workflow has to build the URL
before deploying (`APP_URL` is baked in at deploy time) and a masked value would arrive
in the PR comment as `***`. It doubles as the dev instance's `PREVIEW_RELAY_SUBDOMAIN`, the
allowlist its end of the sign-in relay checks a preview's return origin against.

Fork PRs get no preview. `pull_request` withholds secrets from them, so there would be
nothing to deploy with; the job skips rather than failing halfway.

### Choosing sign-in methods

Nothing here is compiled in. An instance decides what it offers through its environment,
and `GET /api/config` reports the result: the web app and the Android app both draw their
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
withdraws as soon as either arrives, so a self-hoster who configures nothing still gets in,
and unbent.app, which has providers, never sees it. `AUTH_PASSWORD=1` asks for a password
*alongside* a configured provider; `AUTH_PASSWORD=0` refuses the floor, and is the one
setting here that can leave nobody a way in.

An instance that accepts a sign-up from anyone says so in its log: deployed with an empty
`ALLOWED_EMAILS`, the Worker warns once, naming the methods a stranger could use. Set
`PUBLIC_SIGNUPS=1` to say the open door is deliberate and stop the warning; who may sign up
is unchanged either way.

The OAuth row means any of the thirty-five providers Better Auth ships (Apple, Discord,
Microsoft, Slack, GitLab and the rest), not a list this repository maintains. Enabling one
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
and assume the operator controls the directory, historically have: this is the "nOAuth"
class of bug, and it is a property of the identity provider rather than of this code.

So: enable providers you would be willing to let someone sign in as. If you enable one you
are unsure about, turn implicit linking off in `apps/api/src/auth.ts`:

```ts
account: { accountLinking: { disableImplicitLinking: true } },
```

Accounts then link only when someone explicitly asks while already signed in, and a second
provider on an existing address is refused rather than merged. It is the safer setting and
the more annoying one: someone who signed up with Google and then presses Discord is told
the account is not linked instead of being let in.

`ALLOWED_EMAILS` narrows this considerably on a closed instance: an address that cannot
create an account cannot be linked into one either.

Two things to know before removing a provider people already use. An account whose only
credential is that provider loses its way in, so check before deleting. And deploy the
replacement first: a secret deletion takes effect immediately, while new code does not.

OAuth callbacks have to be registered against the real origin before anyone can sign in,
including you:

- Google: `https://unbent.app/api/auth/callback/google`
- GitHub: `https://unbent.app/api/auth/callback/github`
- Apple: `https://unbent.app/api/auth/callback/apple`, on the Services ID (see below)

Then deploy again so the Worker picks up the secrets. `custom_domain = true` means
Cloudflare creates and manages the DNS record and certificate, so there is nothing to add
by hand:

```bash
pnpm release
```

#### Sign in with Apple

Apple is the one provider whose secret is not a value it hands you. `APPLE_CLIENT_ID` is a
**Services ID** (an identifier you create on the developer portal, with Sign in with Apple
enabled and the callback above as its return URL) and `APPLE_CLIENT_SECRET` is a JWT you
sign with a Sign in with Apple key, which Apple refuses once it is more than six months
old. `scripts/apple-client-secret.mjs` makes one from the team id, the key id and the
`.p8`, and pipes it into wrangler without printing it:

```bash
node scripts/apple-client-secret.mjs --team TEAMID --key-id KEYID \
  --client-id com.example.notes.web --key AuthKey_KEYID.p8 \
  | pnpm --dir apps/api exec wrangler secret put APPLE_CLIENT_SECRET
```

It prints the expiry date; put a reminder a week before it. A lapsed secret breaks only the
web Apple button, at the code exchange, while every other way in keeps working, which is
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
account, so unbent.app, which has providers, does not show it. `ALLOWED_EMAILS` gates
account creation whatever the method. See [Choosing sign-in
methods](#choosing-sign-in-methods).

`GET /api/config` reports which methods an instance offers, in display order, so the login
screen and the Android app render from it rather than guessing.

Sessions are cookie-based and same-origin. Better Auth enforces CSRF by requiring a trusted
`Origin`, so API clients outside the browser must send one.
