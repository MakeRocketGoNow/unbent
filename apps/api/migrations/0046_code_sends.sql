-- How many sign-in codes went where today (MAK-206).
--
-- The code endpoint sends a mail to whatever address is typed into it, and the mail
-- provider's free tier allows a hundred a day. Nothing in Better Auth bounds that by
-- address or by day: its limiter is per IP, and a single IP may ask for thousands in a
-- day, so one scanner can spend the whole day's allowance in half an hour and every
-- real sign-in by code fails until midnight UTC. `lib/code-sends.ts` keeps three counts
-- here and refuses past each; the numbers and the reasoning are on its constants.
--
-- One row per scope per UTC day. `scope` is `address:<email>` for the codes one address
-- has had, or `strangers` for the codes sent to addresses with no account, which is the
-- share of the day a bot cycling invented addresses can spend. `day` leads the key so
-- that yesterday's rows go with one range delete on the prefix, which every write does;
-- the table never holds more than today's rows and whatever today has not pruned yet.
--
-- Attempts, not deliveries: a row is counted before the mail is handed to the provider,
-- since an attempt costs the allowance whether or not the address exists.
CREATE TABLE code_sends (
  day     TEXT    NOT NULL,
  scope   TEXT    NOT NULL,
  count   INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (day, scope)
);
