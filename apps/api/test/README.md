# API tests

Two suites, split by what they need to run.

`src/**/*.test.ts` are unit tests: pure functions over a stubbed `Env`, no server and no
bindings. They are the `unit` project and run anywhere, including CI.

`test/**/*.test.ts` run against a live Worker rather than a mock, because the thing under
test is the real D1 query path — a mock would happily return whatever it was told to. They
are the `live` project, and they need a dev server already up.

```bash
# just the unit tests — no server needed, and what CI runs
pnpm --filter @unbent/api test:unit

# both suites
# terminal 1
pnpm --filter @unbent/api dev

# terminal 2
pnpm --filter @unbent/api test
```

`test` runs both projects and then purges the throwaway data the live suite creates, which
is why it is the one to reach for locally. `test:unit` skips that, having created none.

The suite signs up its own actors through the email/password provider, which `.dev.vars`
turns on with `ALLOW_TEST_CREDENTIALS=1`. Deployed environments never set that — though
password sign-in can still appear there on its own, since an instance offers it when nothing
else could create an account. unbent.app has providers, so it does not.

Requests carry an `Origin` header because Better Auth enforces CSRF against a trusted
origin; a client that omits it gets a 403.

Note: `wrangler dev` hot-reloads source but **not** `.dev.vars`. After changing an env var,
restart the dev server or the Worker keeps serving the old configuration.
