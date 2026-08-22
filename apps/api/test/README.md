# API tests

The isolation suite runs against a live Worker rather than a mock, because the thing under
test is the real D1 query path — a mock would happily return whatever it was told to.

```bash
# terminal 1
pnpm --filter @unbent/api dev

# terminal 2
pnpm --filter @unbent/api test
```

The suite signs up its own actors through the email/password provider, which is enabled only
when `ALLOW_TEST_CREDENTIALS=1` is present in `.dev.vars`. Deployed environments never set
it, so production is OAuth-only.

Requests carry an `Origin` header because Better Auth enforces CSRF against a trusted
origin; a client that omits it gets a 403.

Note: `wrangler dev` hot-reloads source but **not** `.dev.vars`. After changing an env var,
restart the dev server or the Worker keeps serving the old configuration.
