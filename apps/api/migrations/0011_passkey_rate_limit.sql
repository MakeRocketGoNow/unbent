-- Passkeys, and the table that makes rate limiting work on Workers.
--
-- Hand-written for the same reason as 0002_auth.sql: the Better Auth CLI cannot load a
-- config that resolves its D1 binding from the request environment. Field names and types
-- were read out of the installed packages rather than the docs, which render the schema
-- from a component and do not show it.

-- @better-auth/passkey's own schema (packages/passkey/src/schema.ts), field for field.
--
-- `createdAt` is nullable because the plugin declares it not-required. 0010_device_code.sql
-- records what happens otherwise: a NOT NULL on a column the plugin omits from its insert
-- breaks the very first call. `backedUp` is INTEGER because SQLite has no boolean, and
-- `counter` is INTEGER because it is a replay counter the authenticator increments.
CREATE TABLE passkey (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  publicKey    TEXT    NOT NULL,
  userId       TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  credentialID TEXT    NOT NULL,
  counter      INTEGER NOT NULL,
  deviceType   TEXT    NOT NULL,
  backedUp     INTEGER NOT NULL,
  transports   TEXT,
  createdAt    TEXT,
  aaguid       TEXT
);

-- Both are marked `index: true` in the plugin schema. Signing in looks a credential up by
-- credentialID; the settings list and a user deletion cascade both go by userId.
CREATE INDEX idx_passkey_userId       ON passkey(userId);
CREATE INDEX idx_passkey_credentialID ON passkey(credentialID);

-- Rate limit counters, required by `rateLimit: { storage: 'database' }`.
--
-- Better Auth defaults this storage to memory, which on Workers is close to useless: every
-- isolate has its own, and they are created and discarded constantly, so the stricter rule
-- on /sign-in/email (3 requests per 10 seconds) would not reliably hold anywhere. Password
-- sign-in is only as good as the limit in front of it, so this table is what makes the
-- shipped password auth defensible.
--
-- Unlike every other timestamp in this schema, `lastRequest` is milliseconds-since-epoch as
-- a number, not ISO-8601 text: the limiter does integer arithmetic on it and compares it
-- with `lte`. It is declared bigint upstream, so INTEGER — which SQLite stores as up to 8
-- bytes — is the right column type. `key` is unique upstream, and the limiter's insert
-- races two isolates against that constraint deliberately, catching the violation and
-- re-reading, so the UNIQUE is load-bearing rather than decorative.
CREATE TABLE rateLimit (
  key         TEXT    PRIMARY KEY,
  count       INTEGER NOT NULL,
  lastRequest INTEGER NOT NULL
);
