/**
 * What the language model has cost this account, and how many Auto-fill presses it has
 * made, by day (MAK-180).
 *
 * Every answer from the model carries a `usage` block and nothing kept it, so there was
 * no per-account figure for the operator's bill, for the account itself, or for an
 * allowance a plan could sell; and a press is one request anyone with a session can
 * loop, with nothing to stop it. This is the number both of those need.
 *
 * One row per day, job and model, upserted: `read`, `title` and `fields` are the model's
 * three jobs, and `press` is the press itself — Jev's two rounds and whatever the model
 * did inside it — with `model` empty and no tokens. The day is UTC, `YYYY-MM-DD`, so a
 * year is a range on the primary key and the daily cap is one lookup on it. `model` is
 * in the key because a token's price is the model's: the counter keeps tokens and who
 * spent them, and anything that shows a price converts at display. An operator who
 * changes `ANTHROPIC_MODEL` mid-day gets a second row rather than a sum of two prices,
 * and one who reads with a dearer model than the one that titles (MAK-182) gets each
 * job's tokens under the model that spent them.
 *
 * The four token counts are the API's own split, kept apart because each is billed at its
 * own rate. `requests` counts the answers the model was paid for, which a retried 5xx is
 * not.
 *
 * Small by construction: at most four rows a day an account uses Auto-fill, so a year is
 * under fifteen hundred. A rowid table, not `WITHOUT ROWID`, because the dump walks every
 * data table by rowid (`dumpSlice`).
 *
 * Not in the feed: no client holds it, and it is not the account's data the way a note
 * is — local to the object, as the feed's own cursor is local to a device. Dumped with
 * the data tables, as of the account's last dump; see `DATA_TABLES` for why that can be
 * up to a week behind.
 */
export default `
CREATE TABLE llm_usage (
  day                TEXT    NOT NULL,
  job                TEXT    NOT NULL,
  model              TEXT    NOT NULL DEFAULT '',
  requests           INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, job, model)
);
`;
