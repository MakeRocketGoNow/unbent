import { BASE_STORAGE_GB, TRIAL_DAYS, type AccountPlan, type PlanSource, type PlanState } from '@unbent/shared';

/**
 * The plan an account is on (MAK-108): the `account_plan` row (migration 0045), what it
 * means right now, and the reads and writes that keep it.
 *
 * The row says what was decided and when it stops holding; this module says what the
 * account *is*, which is the row against the clock. Nothing here knows about Paddle — the
 * webhook (routes/billing.ts) and the operator's comp both end in `updatePlan` — and
 * nothing here knows whether billing is even on. That is the caller's question
 * (`billingOn` in lib/paddle.ts): an instance that sells nothing never asks.
 */

export interface PlanRow {
  userId: string;
  plan: PlanState;
  planUntil: number | null;
  storageGb: number;
  source: PlanSource | null;
  paddleCustomerId: string | null;
  paddleSubscriptionId: string | null;
  paddleStatus: string | null;
  /** A cancellation asked for and still ahead, from the subscription's scheduled change. */
  paddleCancelsAt: number | null;
  /** When the newest Paddle event applied to this row happened, RFC 3339, for ordering. */
  paddleEventAt: string | null;
  lapseNotifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface RawRow {
  user_id: string;
  plan: PlanState;
  plan_until: number | null;
  storage_gb: number;
  source: PlanSource | null;
  paddle_customer_id: string | null;
  paddle_subscription_id: string | null;
  paddle_status: string | null;
  paddle_cancels_at: number | null;
  paddle_event_at: string | null;
  lapse_notified_at: number | null;
  created_at: number;
  updated_at: number;
}

const toRow = (r: RawRow): PlanRow => ({
  userId: r.user_id,
  plan: r.plan,
  planUntil: r.plan_until,
  storageGb: r.storage_gb,
  source: r.source,
  paddleCustomerId: r.paddle_customer_id,
  paddleSubscriptionId: r.paddle_subscription_id,
  paddleStatus: r.paddle_status,
  paddleCancelsAt: r.paddle_cancels_at,
  paddleEventAt: r.paddle_event_at,
  lapseNotifiedAt: r.lapse_notified_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const COLUMNS = `user_id, plan, plan_until, storage_gb, source, paddle_customer_id, paddle_subscription_id,
  paddle_status, paddle_cancels_at, paddle_event_at, lapse_notified_at, created_at, updated_at`;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** When a trial that starts at `now` runs out. */
export function trialEnd(now: number): number {
  return now + TRIAL_DAYS * DAY_MS;
}

/**
 * What the account is at `now`: the row's word, unless its end has passed. A missing row
 * is a trial that starts now — `planFor` writes it, and a reader that reaches here with
 * null (the first request after sign-up, a hook that failed) is told what it would read
 * once it has.
 */
export function planStateOf(row: PlanRow | null, now: number): PlanState {
  if (!row) return 'trial';
  if (row.plan === 'inactive') return 'inactive';
  if (row.planUntil !== null && row.planUntil <= now) return 'inactive';
  return row.plan;
}

/** The row as the Plan page reads it. `usedBytes` is the store's and added by the route. */
export function accountPlanOf(row: PlanRow, now: number): AccountPlan {
  const state = planStateOf(row, now);
  const paddle = row.source === 'paddle' && row.paddleStatus;
  return {
    state,
    until: row.planUntil,
    source: row.source,
    storageGb: row.storageGb,
    subscription: paddle
      ? {
          status: row.paddleStatus!,
          // A cancellation still ahead: the scheduled change while Paddle has the
          // subscription `active`, or, once it has taken effect and the status is
          // `canceled`, the end of the period that was paid for, which the account keeps
          // until it passes. Null once that has passed too: nothing is ahead.
          cancelsAt:
            row.paddleCancelsAt ??
            (row.paddleStatus === 'canceled' && row.planUntil !== null && row.planUntil > now ? row.planUntil : null),
          pastDue: row.paddleStatus === 'past_due',
        }
      : null,
  };
}

/** The account's row, or null for one that has none yet. */
export async function planRow(db: D1Database, userId: string): Promise<PlanRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM account_plan WHERE user_id = ?1`).bind(userId).first<RawRow>();
  return row ? toRow(row) : null;
}

/** The row a Paddle customer id names, for the webhook; null for an id no row holds. */
export async function planRowByCustomer(db: D1Database, customerId: string): Promise<PlanRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM account_plan WHERE paddle_customer_id = ?1`).bind(customerId).first<RawRow>();
  return row ? toRow(row) : null;
}

/**
 * The statement that starts an account's trial, as a statement so the sign-up hook and
 * `planFor` share it. Idempotent: an account that has a row keeps it, whatever it says.
 */
export function ensurePlanRowStatement(db: D1Database, userId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO account_plan (user_id, plan, plan_until, storage_gb, created_at, updated_at)
       VALUES (?1, 'trial', ?2, ?3, ?4, ?4) ON CONFLICT(user_id) DO NOTHING`,
    )
    .bind(userId, trialEnd(now), BASE_STORAGE_GB, now);
}

export async function ensurePlanRow(db: D1Database, userId: string, now = Date.now()): Promise<void> {
  await ensurePlanRowStatement(db, userId, now).run();
}

/**
 * The account's row, made if it is missing. The sign-up hook writes one, and a hook can
 * fail without failing the sign-up it follows (see `ensureDirectoryRow`'s caller), so the
 * first read heals what the hook missed: a fortnight from now, as the hook would have
 * given. Two reads on that one path, one everywhere else.
 */
export async function planFor(db: D1Database, userId: string, now = Date.now()): Promise<PlanRow> {
  const row = await planRow(db, userId);
  if (row) return row;
  await ensurePlanRow(db, userId, now);
  return (await planRow(db, userId)) ?? {
    userId,
    plan: 'trial',
    planUntil: trialEnd(now),
    storageGb: BASE_STORAGE_GB,
    source: null,
    paddleCustomerId: null,
    paddleSubscriptionId: null,
    paddleStatus: null,
    paddleCancelsAt: null,
    paddleEventAt: null,
    lapseNotifiedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** What a comp or a webhook writes. Every field named is set; the rest stay. */
export interface PlanPatch {
  plan?: PlanState;
  planUntil?: number | null;
  storageGb?: number;
  source?: PlanSource | null;
  paddleCustomerId?: string | null;
  paddleSubscriptionId?: string | null;
  paddleStatus?: string | null;
  paddleCancelsAt?: number | null;
  paddleEventAt?: string | null;
  lapseNotifiedAt?: number | null;
}

const COLUMN_OF: Record<keyof PlanPatch, string> = {
  plan: 'plan',
  planUntil: 'plan_until',
  storageGb: 'storage_gb',
  source: 'source',
  paddleCustomerId: 'paddle_customer_id',
  paddleSubscriptionId: 'paddle_subscription_id',
  paddleStatus: 'paddle_status',
  paddleCancelsAt: 'paddle_cancels_at',
  paddleEventAt: 'paddle_event_at',
  lapseNotifiedAt: 'lapse_notified_at',
};

/**
 * The update as a statement, for a caller that batches it with something else — the
 * webhook, with the event's own row. `notBefore` is the webhook's guard against an event
 * delivered late: with it, the update applies only while the row's newest event is not
 * after this one, and an older event arriving after a newer one changes nothing.
 */
export function updatePlanStatement(
  db: D1Database,
  userId: string,
  patch: PlanPatch,
  now: number,
  opts: { notBefore?: string } = {},
): D1PreparedStatement {
  const sets: string[] = ['updated_at = ?2'];
  const binds: unknown[] = [userId, now];
  for (const key of Object.keys(patch) as Array<keyof PlanPatch>) {
    const value = patch[key];
    if (value === undefined) continue;
    binds.push(value);
    sets.push(`${COLUMN_OF[key]} = ?${binds.length}`);
  }
  let where = 'user_id = ?1';
  if (opts.notBefore !== undefined) {
    binds.push(opts.notBefore);
    where += ` AND (paddle_event_at IS NULL OR paddle_event_at <= ?${binds.length})`;
  }
  return db.prepare(`UPDATE account_plan SET ${sets.join(', ')} WHERE ${where}`).bind(...binds);
}

export async function updatePlan(db: D1Database, userId: string, patch: PlanPatch, now = Date.now()): Promise<void> {
  await updatePlanStatement(db, userId, patch, now).run();
}

/**
 * The accounts whose plan has run out and have not been told, oldest end first: what the
 * sweep mails (lib/plan-mail.ts). A range on `idx_account_plan_lapse_due`, whose
 * conditions this repeats word for word so the planner takes it; `migrations.test.ts`
 * pins the plan. Binds: now, and the most to take.
 */
export const LAPSE_DUE_SQL = `SELECT p.user_id, p.plan, p.plan_until, p.source, u.email
    FROM account_plan p JOIN user u ON u.id = p.user_id
   WHERE p.lapse_notified_at IS NULL AND p.plan_until IS NOT NULL AND p.plan <> 'inactive'
     AND p.plan_until <= ?1
   ORDER BY p.plan_until LIMIT ?2`;
