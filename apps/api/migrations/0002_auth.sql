-- Better Auth core schema.
--
-- Hand-written rather than CLI-generated: the Better Auth CLI cannot load a config that
-- resolves its D1 binding from the request environment, and a reviewable migration is
-- worth more here than a generated one. Column names use Better Auth's camelCase
-- convention because its queries reference them verbatim.
--
-- Timestamps are TEXT ISO-8601: Better Auth's SQLite dialect binds JS Dates as ISO
-- strings, verified by inspecting real rows after a sign-up. SQLite's dynamic typing
-- would accept an INTEGER declaration silently and store strings anyway, so the column
-- types here are declared to match what is actually written.

CREATE TABLE user (
  id            TEXT PRIMARY KEY,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image         TEXT,
  createdAt     TEXT    NOT NULL,
  updatedAt     TEXT    NOT NULL
);

CREATE TABLE session (
  id        TEXT PRIMARY KEY,
  userId    TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token     TEXT    NOT NULL UNIQUE,
  expiresAt TEXT    NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt TEXT    NOT NULL,
  updatedAt TEXT    NOT NULL
);

-- Every authenticated request looks a session up by token, so this index is hot.
CREATE INDEX idx_session_token  ON session(token);
CREATE INDEX idx_session_userId ON session(userId);

CREATE TABLE account (
  id                    TEXT PRIMARY KEY,
  userId                TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accountId             TEXT    NOT NULL,
  providerId            TEXT    NOT NULL,
  issuer                TEXT,
  accessToken           TEXT,
  refreshToken          TEXT,
  accessTokenExpiresAt  TEXT,
  refreshTokenExpiresAt TEXT,
  scope                 TEXT,
  idToken               TEXT,
  password              TEXT,
  createdAt             TEXT    NOT NULL,
  updatedAt             TEXT    NOT NULL
);

-- One provider account maps to exactly one user.
CREATE UNIQUE INDEX idx_account_provider ON account(providerId, accountId);
CREATE INDEX idx_account_userId ON account(userId);

CREATE TABLE verification (
  id         TEXT PRIMARY KEY,
  identifier TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  expiresAt  TEXT    NOT NULL,
  createdAt  TEXT    NOT NULL,
  updatedAt  TEXT    NOT NULL
);

CREATE INDEX idx_verification_identifier ON verification(identifier);
