-- What a connected assistant told the operator about the tools (MAK-212;
-- src/lib/assistant-feedback.ts, the `send_feedback` tool in src/mcp/tools/feedback.ts,
-- and the operator page's list).
--
-- An assistant that hits a tool answering the wrong thing, an error that does not say how
-- to recover, or a capability that is not there, is the only one who sees it happen; the
-- person sees only that the assistant struggled. This keeps its account of it, a row a
-- call, until the operator has read it.
--
-- `client_id` is the OAuth client that sent it, and `client_name` the name it registered
-- under, copied at the time: a client can be deleted, and "which assistant was this" is
-- the first question every row raises. `tool` is the tool the feedback is about, when it
-- is about one. `read_at` is set when the operator dismisses the row from the page, which
-- lists only unread rows; a dismissed row stays until it ages out, so a dismiss is never
-- the loss of anything.
--
-- With the account by foreign key, so a deleted account's feedback goes with its `user`
-- row and nothing in `lib/account-deletion.ts` has to remember it.
--
-- Three indexes, all for statements on this table alone (a new table, so no other
-- statement's plan moves, AGENTS.md): the account's recent rows, which the day's bound
-- counts on every write; the age, which the prune deletes by range; and the unread rows
-- by age, which the operator's newest-first list walks. That last one is partial, so the
-- list never reads a dismissed row: without it the list went in by the age index and
-- stepped past every row dismissed in the last ninety days, which is most of the table
-- once the operator keeps up, on every refetch of a page left open.
CREATE TABLE assistant_feedback (
  id          INTEGER PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  client_id   TEXT    NOT NULL,
  client_name TEXT,
  category    TEXT    NOT NULL,
  tool        TEXT,
  body        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);

CREATE INDEX idx_assistant_feedback_user ON assistant_feedback(user_id, created_at);
CREATE INDEX idx_assistant_feedback_created ON assistant_feedback(created_at);
CREATE INDEX idx_assistant_feedback_unread ON assistant_feedback(created_at) WHERE read_at IS NULL;
