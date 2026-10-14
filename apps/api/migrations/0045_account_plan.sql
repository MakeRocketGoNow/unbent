-- Which plan each account is on, and the subscription behind it (MAK-108).
--
-- One row per account. `plan` is what the row says the account is — on its trial, paid
-- for, or lapsed — and `plan_until` is when that stops being true: the trial's end, the
-- end of the period a subscription has paid for, the end of a comp. What the account *is*
-- right now is worked out from the two against the clock (`planStateOf` in lib/plan.ts),
-- so a trial that ran out at midnight reads as `inactive` from midnight without a job
-- having to come round and say so. `plan` moves only when something is decided: a
-- subscription starting, Paddle reporting its status, an operator comping the account.
--
-- A comp is a row with `source = 'comp'`, `plan = 'active'`, an end or null for none, and
-- no Paddle ids: the owner, a gifted friend. Paddle never hears of it — a discount of
-- 100% there still asks for a card and charges it when the discount ends — and the
-- webhook finds rows by Paddle's ids alone, so it cannot touch one. Set from the
-- operator's page (`POST /api/admin/accounts/:id/plan`).
--
-- The Paddle columns are the join to Paddle's side. The customer id is written at the
-- first checkout, before the transaction is made, and is what every event is matched by;
-- the subscription id follows with the first event that names it. `paddle_status` is
-- Paddle's own word for the subscription, kept for the Plan page's sentence ("renews",
-- "cancels on", "payment failed"), `paddle_cancels_at` a cancellation asked for and still
-- ahead (Paddle keeps the status `active` until it takes effect), and `paddle_event_at`
-- is when the newest event applied to this row happened, so an event delivered late —
-- Paddle promises delivery, not order — does not write an older status over a newer one.
--
-- `storage_gb` is what the account may hold: the plan's base plus the add-ons bought,
-- written by the webhook from the subscription's items, or whatever an operator comped.
-- The quota is enforced on upload against the store's own count of its files' bytes.
--
-- `lapse_notified_at` is when the account was told it had gone `inactive` (the sweep
-- sends the mail, lib/plan-mail.ts), and is cleared when it becomes active again, so the
-- next lapse is told once more.
--
-- With the account (`ON DELETE CASCADE`), like `legal_agreement`: a plan row is a record
-- about a person. Not the directory's reason for having no foreign key — nothing here
-- needs to outlive the account; the subscription is cancelled with Paddle before the row
-- goes (lib/account-deletion.ts).
--
-- Not backfilled, and the sign-up hook writes a row only while billing is on. A trial
-- dated from this migration, or from a sign-up made while billing was off, would run out
-- before anyone knew there was a trial: the live Paddle keys follow this deploy by days,
-- and the day they went on every account older than a fortnight would have turned
-- read-only at once and been mailed about a trial it was never told of. Instead an
-- account's fortnight starts at its first request after billing is on (`planFor` heals
-- a missing row), which is the first moment the Plan tab and the trial banner can say so.
-- The operator comps whoever should not be asked to pay before it is up.
CREATE TABLE account_plan (
  user_id                TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  plan                   TEXT NOT NULL CHECK (plan IN ('trial', 'active', 'inactive')),
  plan_until             INTEGER,
  storage_gb             INTEGER NOT NULL DEFAULT 10,
  source                 TEXT CHECK (source IN ('paddle', 'comp')),
  paddle_customer_id     TEXT,
  paddle_subscription_id TEXT,
  paddle_status          TEXT,
  paddle_cancels_at      INTEGER,
  paddle_event_at        TEXT,
  lapse_notified_at      INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- The webhook's way in: one row per Paddle customer, found by their id. Unique, because
-- two accounts under one Paddle customer would both be moved by one subscription.
CREATE UNIQUE INDEX idx_account_plan_customer ON account_plan(paddle_customer_id)
  WHERE paddle_customer_id IS NOT NULL;

-- The sweep's: the accounts whose end has passed and have not been told. Partial on the
-- two conditions the one statement that reads it repeats (`LAPSE_DUE_SQL` in
-- lib/plan.ts), so a walk finds the few rows that are due and nothing else. The planner
-- takes any index it can use (AGENTS.md, "Rows read are still the budget"), and the
-- table's other statements go by `user_id` or the customer id, which this cannot serve.
CREATE INDEX idx_account_plan_lapse_due ON account_plan(plan_until)
  WHERE lapse_notified_at IS NULL AND plan_until IS NOT NULL AND plan <> 'inactive';

-- Every Paddle event applied, by its id, so a redelivery — Paddle retries anything not
-- answered 200 within five seconds — applies nothing twice. Written in the same batch as
-- the change the event made; a row here and no change cannot happen. Never read but by
-- the insert that refuses a repeat, so the key is its only index. Never trimmed, on
-- purpose: a subscriber's year is a handful of events, so the table grows by rows a
-- year per paying account, and a periodic delete would be a D1 write on every sweep to
-- save less than that. If it ever matters, Paddle stops retrying after a few days, so
-- anything older than a month can go.
CREATE TABLE billing_event (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
