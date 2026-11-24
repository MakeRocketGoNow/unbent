-- What each connected assistant may reach of an account (MAK-264; src/lib/assistant-grants.ts,
-- the check in src/mcp/auth.ts, and Settings > Connected apps).
--
-- Connecting an assistant used to grant everything, to every assistant alike. A row here
-- is one connection (an OAuth client, for one account) given less: some notebooks, or
-- reading only, or both. No row is the whole library with writes, which is what every
-- connection made before this has and what the consent screen still offers first.
--
-- `notebooks` is a JSON list of notebook ids, or NULL for every notebook. The ids are the
-- note store's, which D1 cannot check, and need no checking: one that names no notebook
-- grants nothing, so a notebook deleted later leaves a dead id and no cleanup. `unfiled`
-- is whether the notes in no notebook are reached too, read only beside a list.
-- `read_only` withholds the tools that change anything.
--
-- In D1, beside `oauthConsent`, and not in the token or the note store. The MCP endpoint
-- already reads the consent row on every call, to know the app has not been
-- disconnected, so the grant joins that read and costs no request of its own; an edit
-- holds from the next call, where a claim in the token would hold for the hour the
-- token lasts; and whether a connection may write has to be known before its tools are
-- registered, which is before anything is asked of the store.
--
-- Keyed by the account and the client, the pair `oauthConsent` is looked up by. With
-- both by foreign key: a deleted account's grants go with its `user` row, as its
-- consents do, and a client that is deleted takes its grants as it takes its consents.
-- Disconnecting an app deletes its row by hand (`ConnectedAppsRepo.disconnect`), since
-- that removes a consent and not a client, and a grant left behind would be what a
-- reconnect started from.
--
-- No index beyond the key: every statement on this table names both columns, or the
-- account alone, which the key leads with. A new table, so no other statement's plan
-- moves (AGENTS.md).
CREATE TABLE assistant_grants (
  user_id    TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  client_id  TEXT    NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  notebooks  TEXT,
  unfiled    INTEGER NOT NULL DEFAULT 0,
  read_only  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id)
);
