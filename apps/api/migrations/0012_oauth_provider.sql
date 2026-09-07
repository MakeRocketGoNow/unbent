-- OAuth 2.1 authorization server tables, so an AI assistant can connect over MCP.
--
-- Connecting Claude or another MCP client is not a session in a browser: the client
-- registers itself, sends the user here to approve it, and then calls the API with a token
-- that belongs to the client rather than to a browser. That is an OAuth authorization
-- server, and these are the tables Better Auth's oauth-provider plugin queries to be one.
--
-- Shape and column names come from the plugins' own schemas, read out of the installed
-- packages rather than transcribed from documentation, for the reason 0002_auth.sql gives:
-- the plugin queries these names verbatim. camelCase columns and TEXT ISO-8601 timestamps
-- for the same reason. Hand-written for the same reason too — the Better Auth CLI cannot
-- load a config whose D1 binding is resolved per-request.
--
-- Nullability follows the plugin schemas exactly, which is the lesson 0010_device_code.sql
-- records: a NOT NULL on a column the plugin omits from an insert breaks the very first
-- call. Only columns the plugin declares required are NOT NULL here.
--
-- Types map as they do elsewhere in this schema: `string[]` and `json` are TEXT holding
-- JSON, `date` is TEXT, `boolean` is INTEGER.

-- Signing keys for the tokens issued below. The JWT plugin owns this table and publishes
-- the public half at /api/auth/jwks, which is what lets the MCP route verify a token by
-- signature instead of a database lookup on every tool call.
CREATE TABLE jwks (
  id         TEXT PRIMARY KEY,
  publicKey  TEXT NOT NULL,
  privateKey TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  expiresAt  TEXT,
  -- Nullable: rows predating per-resource signing have no algorithm recorded, and readers
  -- fall back to the configured default.
  alg        TEXT,
  crv        TEXT
);

-- A registered client. Rows here are created by clients themselves through dynamic client
-- registration, which is how Claude.ai and Cursor connect without anyone provisioning
-- credentials by hand — so this table grows without a human in the loop, and the
-- registration endpoint is rate limited in auth.ts for that reason.
CREATE TABLE oauthClient (
  id                               TEXT PRIMARY KEY,
  clientId                         TEXT NOT NULL,
  clientSecret                     TEXT,
  clientDiscoveryId                TEXT,
  disabled                         INTEGER,
  skipConsent                      INTEGER,
  enableEndSession                 INTEGER,
  subjectType                      TEXT,
  scopes                           TEXT,
  clientCredentialsScopes          TEXT,
  -- Who registered it, when a signed-in user did. Null for the unauthenticated
  -- registration an MCP client performs before anyone has approved anything.
  userId                           TEXT REFERENCES user(id) ON DELETE CASCADE,
  createdAt                        TEXT,
  updatedAt                        TEXT,
  name                             TEXT,
  uri                              TEXT,
  icon                             TEXT,
  contacts                         TEXT,
  tos                              TEXT,
  policy                           TEXT,
  softwareId                       TEXT,
  softwareVersion                  TEXT,
  softwareStatement                TEXT,
  redirectUris                     TEXT NOT NULL,
  postLogoutRedirectUris           TEXT,
  backchannelLogoutUri             TEXT,
  backchannelLogoutSessionRequired INTEGER,
  tokenEndpointAuthMethod          TEXT,
  applicationType                  TEXT,
  jwks                             TEXT,
  jwksUri                          TEXT,
  grantTypes                       TEXT,
  responseTypes                    TEXT,
  requirePKCE                      INTEGER,
  dpopBoundAccessTokens            INTEGER,
  referenceId                      TEXT,
  metadata                         TEXT
);

-- Looked up by client id on every authorization and every token request, and unique
-- because two rows sharing one would make "which client is this" ambiguous. Also what the
-- foreign keys below point at, which SQLite requires to be unique.
CREATE UNIQUE INDEX idx_oauthClient_clientId ON oauthClient(clientId);

-- The protected resources tokens can be bound to. This instance registers exactly one —
-- the MCP endpoint — and binding tokens to it is what stops a token minted for somewhere
-- else being replayed here.
CREATE TABLE oauthResource (
  id                            TEXT PRIMARY KEY,
  identifier                    TEXT NOT NULL,
  name                          TEXT NOT NULL,
  accessTokenTtl                INTEGER,
  refreshTokenTtl               INTEGER,
  signingAlgorithm              TEXT,
  signingKeyId                  TEXT,
  allowedScopes                 TEXT,
  customClaims                  TEXT,
  dpopBoundAccessTokensRequired INTEGER,
  disabled                      INTEGER,
  createdAt                     TEXT,
  updatedAt                     TEXT,
  policyVersion                 INTEGER,
  metadata                      TEXT
);

CREATE UNIQUE INDEX idx_oauthResource_identifier ON oauthResource(identifier);

-- Which clients may ask for which resources.
CREATE TABLE oauthClientResource (
  id         TEXT PRIMARY KEY,
  clientId   TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  resourceId TEXT NOT NULL REFERENCES oauthResource(identifier) ON DELETE CASCADE,
  metadata   TEXT,
  createdAt  TEXT
);

CREATE INDEX idx_oauthClientResource_clientId ON oauthClientResource(clientId);

-- Refresh tokens. Created before access tokens because an access token row points at one.
--
-- Rotation is a compare-and-swap on `revoked` rather than a transaction, which is what
-- makes this plugin usable on D1 at all: D1 has no interactive transactions, and the
-- provider's rotation path deliberately uses an atomic single-row update instead.
CREATE TABLE oauthRefreshToken (
  id                      TEXT PRIMARY KEY,
  token                   TEXT NOT NULL,
  clientId                TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  -- Set null rather than cascade: signing out of the browser should not silently revoke a
  -- connected assistant, which is a separate grant the user manages in settings.
  sessionId               TEXT REFERENCES session(id) ON DELETE SET NULL,
  userId                  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  referenceId             TEXT,
  authorizationCodeId     TEXT,
  resources               TEXT,
  requestedUserInfoClaims TEXT,
  expiresAt               TEXT,
  createdAt               TEXT,
  revoked                 TEXT,
  rotatedAt               TEXT,
  rotationReplayResponse  TEXT,
  rotationReplayExpiresAt TEXT,
  authTime                TEXT,
  confirmation            TEXT,
  scopes                  TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_oauthRefreshToken_token ON oauthRefreshToken(token);
-- Revoking every grant for one connected app is a query on this pair.
CREATE INDEX idx_oauthRefreshToken_client_user ON oauthRefreshToken(clientId, userId);

-- Access tokens. Verified by signature at the MCP route, so this table is not read on the
-- hot path; it exists so a token can be introspected and revoked.
CREATE TABLE oauthAccessToken (
  id                      TEXT PRIMARY KEY,
  token                   TEXT,
  clientId                TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  sessionId               TEXT REFERENCES session(id) ON DELETE SET NULL,
  userId                  TEXT REFERENCES user(id) ON DELETE CASCADE,
  referenceId             TEXT,
  authorizationCodeId     TEXT,
  resources               TEXT,
  requestedUserInfoClaims TEXT,
  refreshId               TEXT REFERENCES oauthRefreshToken(id) ON DELETE CASCADE,
  expiresAt               TEXT,
  createdAt               TEXT,
  revoked                 TEXT,
  confirmation            TEXT,
  scopes                  TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_oauthAccessToken_token ON oauthAccessToken(token);
CREATE INDEX idx_oauthAccessToken_client_user ON oauthAccessToken(clientId, userId);
-- Family invalidation deletes access tokens by their parent refresh row.
CREATE INDEX idx_oauthAccessToken_refreshId ON oauthAccessToken(refreshId);

-- What a user has approved for a client, so a returning assistant is not asked again.
-- Deleting a row here is what "disconnect this app" means in settings.
CREATE TABLE oauthConsent (
  id                      TEXT PRIMARY KEY,
  clientId                TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  userId                  TEXT REFERENCES user(id) ON DELETE CASCADE,
  referenceId             TEXT,
  resources               TEXT,
  requestedUserInfoClaims TEXT,
  scopes                  TEXT NOT NULL,
  createdAt               TEXT,
  updatedAt               TEXT
);

-- Looked up by this pair on every authorization, to decide whether to show the consent
-- screen. Not unique: the plugin scopes consent by an optional reference id as well.
CREATE INDEX idx_oauthConsent_client_user ON oauthConsent(clientId, userId);

-- Replay tombstones for clients that authenticate with a signed assertion rather than a
-- secret. Unused by the public MCP flow, and created anyway because the plugin's schema
-- declares it and a missing table is a runtime error rather than a degraded feature.
CREATE TABLE oauthClientAssertion (
  id        TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL
);
