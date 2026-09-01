-- Device authorization codes (RFC 8628), for signing a CLI in without handling a secret.
--
-- The migration tool needs to act as a user, but a CLI has nowhere safe to put a password
-- and no business asking for one. The device flow instead has the CLI print a short code,
-- the user approve it in a browser they are already signed in to, and the CLI collect an
-- ordinary session — so no credential is ever typed into, displayed by, or stored by the
-- CLI. The alternative, a generated API token pasted from a settings page, puts a
-- long-lived secret through the clipboard and into shell history.
--
-- Shape and column names come from the Better Auth plugin's own schema, which queries
-- these verbatim; camelCase and TEXT ISO-8601 timestamps for the same reasons as
-- 0002_auth.sql. Hand-written for the same reason too: the CLI cannot load a config whose
-- D1 binding is resolved per-request.

CREATE TABLE deviceCode (
  id              TEXT PRIMARY KEY,
  deviceCode      TEXT    NOT NULL,
  userCode        TEXT    NOT NULL,
  -- Null until approval: the row is created by an unauthenticated CLI and only learns
  -- which user it belongs to when someone approves it in the browser.
  userId          TEXT    REFERENCES user(id) ON DELETE CASCADE,
  expiresAt       TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  lastPolledAt    TEXT,
  pollingInterval INTEGER,
  clientId        TEXT,
  scope           TEXT,
  -- Nullable, unlike every other table here: the plugin's schema does not declare these
  -- and its insert omits them, so NOT NULL fails the very first /device/code call. Kept
  -- rather than dropped because a stale row is easier to reason about with a timestamp on
  -- it, and expiresAt alone does not say when a code was issued.
  createdAt       TEXT,
  updatedAt       TEXT
);

-- Both are lookup keys on every poll and every approval, and both must be unique: two rows
-- sharing a user code would make approval ambiguous about which device it authorized.
CREATE UNIQUE INDEX idx_deviceCode_deviceCode ON deviceCode(deviceCode);
CREATE UNIQUE INDEX idx_deviceCode_userCode   ON deviceCode(userCode);
