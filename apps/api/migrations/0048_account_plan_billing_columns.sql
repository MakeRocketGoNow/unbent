-- The plan row names its provider's ids by what they are, not by whose they were.
--
-- 0045 made the row with `paddle_*` columns and `source IN ('paddle', 'comp')`, since
-- Paddle was the merchant of record the plan was built against. Paddle's seller
-- verification turned out to be a dead end for a Minnesota single-member LLC (it asked
-- for a government document naming the owner, which the state does not issue), and the
-- plan is sold through Stripe Managed Payments instead, before any sale was made.
--
-- The columns hold the same things under either provider: the customer the webhook
-- finds the row by, the subscription behind the plan, the provider's own word for its
-- status, a cancellation ahead, and the stamp of the newest event applied. So they are
-- renamed for what they hold (`billing_*`) rather than for Stripe, which is the second
-- provider in a week and need not be the last. The CHECK on `source` is the one thing a
-- rename cannot reach: SQLite cannot alter a constraint in place, which is why this is a
-- rebuild and not five `RENAME COLUMN`s, and why the new value goes in while the table
-- is open anyway.
--
-- Rows that were Paddle's (only the dev instance has any: production never had the
-- Paddle secrets, so it never wrote one) keep their plan, its end and their storage,
-- and lose the ids and the source. That is the truthful row for them: paid for until
-- a date, through a provider this code can no longer ask about, and then a lapsed
-- account like any other, with the checkout as its way back. A Paddle subscription
-- id on a row Stripe's webhook reads would be a join to nothing.
--
-- Nothing references `account_plan`, so the drop cascades into nothing (0017's lesson
-- was about dropping a table other rows pointed at); `account_plan` itself points at
-- `user`, which stays. The two indexes are recreated under their old names, since
-- `LAPSE_DUE_SQL` and `migrations.test.ts` pin them by name.

CREATE TABLE account_plan_new (
  user_id                 TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  plan                    TEXT NOT NULL CHECK (plan IN ('trial', 'active', 'inactive')),
  plan_until              INTEGER,
  storage_gb              INTEGER NOT NULL DEFAULT 10,
  source                  TEXT CHECK (source IN ('stripe', 'comp')),
  billing_customer_id     TEXT,
  billing_subscription_id TEXT,
  billing_status          TEXT,
  billing_cancels_at      INTEGER,
  billing_event_at        TEXT,
  lapse_notified_at       INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

INSERT INTO account_plan_new (
  user_id, plan, plan_until, storage_gb, source,
  billing_customer_id, billing_subscription_id, billing_status, billing_cancels_at, billing_event_at,
  lapse_notified_at, created_at, updated_at
)
SELECT
  user_id, plan, plan_until, storage_gb,
  CASE WHEN source = 'paddle' THEN NULL ELSE source END,
  CASE WHEN source = 'paddle' THEN NULL ELSE paddle_customer_id END,
  CASE WHEN source = 'paddle' THEN NULL ELSE paddle_subscription_id END,
  CASE WHEN source = 'paddle' THEN NULL ELSE paddle_status END,
  CASE WHEN source = 'paddle' THEN NULL ELSE paddle_cancels_at END,
  CASE WHEN source = 'paddle' THEN NULL ELSE paddle_event_at END,
  lapse_notified_at, created_at, updated_at
FROM account_plan;

DROP TABLE account_plan;
ALTER TABLE account_plan_new RENAME TO account_plan;

-- The webhook's way in: one row per customer, found by their id. Unique, because two
-- accounts under one customer would both be moved by one subscription.
CREATE UNIQUE INDEX idx_account_plan_customer ON account_plan(billing_customer_id)
  WHERE billing_customer_id IS NOT NULL;

-- The sweep's, as 0045 made it: see `LAPSE_DUE_SQL` in lib/plan.ts.
CREATE INDEX idx_account_plan_lapse_due ON account_plan(plan_until)
  WHERE lapse_notified_at IS NULL AND plan_until IS NOT NULL AND plan <> 'inactive';
