# API tests

The isolation suite runs against a live Worker rather than a mock, because the thing under
test is the real D1 query path — a mock would happily return whatever the mock was told to.

```bash
# terminal 1
pnpm --filter @unbent/api dev

# terminal 2
pnpm --filter @unbent/api test
```

The suite signs up its own actors through the email/password provider, which is disabled in
`src/auth.ts` by default. Enable it for the run:

```bash
sed -i '' 's|emailAndPassword: { enabled: false }|emailAndPassword: { enabled: true }|' src/auth.ts
```

Once OAuth credentials are configured in `.dev.vars`, replace the sign-up helper with a
session minted directly against D1 so the suite no longer needs a password provider.
