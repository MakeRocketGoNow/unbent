import { BASE_STORAGE_GB, TRIAL_DAYS, type AccountPlan, type PlanSource, type PlanState } from '@unbent/shared';

/**
 * The plan an account is on (MAK-108): the `account_plan` row (migration 0045, its
 * columns renamed by 0048), what it means right now, and the reads and writes that keep
 * it.
 *
 * The row says what was decided and when it stops holding; this module says what the
 * account *is*, which is the row against the clock. Nothing here knows about Stripe: the
 * webhook (routes/billing.ts) and the operator's comp both end in `updatePlan`, and
 * nothing here knows whether billing is even on. That is the caller's question
 * (`billingOn` in lib/stripe.ts): an instance that sells nothing never asks. The
 * `billing_*` columns are named for what they hold rather than for the provider, since
 * Stripe is the second one (0048 says why) and the row's shape did not change with it.
 */

export interface PlanRow {
  userId: string;
  plan: PlanState;
  planUntil: number | null;
  storageGb: number;
  source: PlanSource | null;
  /** The provider's customer, written at the first checkout: what the webhook finds the row by. */
  customerId: string | null;
  subscriptionId: string | null;
  /** The provider's own word for the subscription: `active`, `past_due`, `canceled` and the rest. */
  subscriptionStatus: string | null;
  /** A cancellation asked for and still ahead, while the subscription is still active. */
  cancelsAt: number | null;
  /** When the newest provider event applied to this row happened, RFC 3339, for ordering. */
  eventAt: string | null;
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
  billing_customer_id: string | null;
  billing_subscription_id: string | null;
  billing_status: string | null;
  billing_cancels_at: number | null;
  billing_event_at: string | null;
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
  customerId: r.billing_customer_id,
  subscriptionId: r.billing_subscription_id,
  subscriptionStatus: r.billing_status,
  cancelsAt: r.billing_cancels_at,
  eventAt: r.billing_event_at,
  lapseNotifiedAt: r.lapse_notified_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const COLUMNS = `user_id, plan, plan_until, storage_gb, source, billing_customer_id, billing_subscription_id,
  billing_status, billing_cancels_at, billing_event_at, lapse_notified_at, created_at, updated_at`;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** When a trial that starts at `now` runs out. */
export function trialEnd(now: number): number {
  return now + TRIAL_DAYS * DAY_MS;
}

/**
 * How long a renewing subscription stays active past the end of its paid period while
 * the renewal's news is on its way. `plan_until` is the period's end, which is also the
 * instant Stripe bills the renewal; the `invoice.paid` and `customer.subscription.updated`
 * that carry the next period land after the charge clears, usually minutes, but
 * after the end and never before. Without a grace every subscriber in good standing
 * read as `inactive` at their anniversary: 402s on every write, the editor locked, and
 * the hourly mail able to tell a paying customer their subscription had ended. A day
 * covers a slow charge and a webhook Stripe had to retry; a renewal that fails for good
 * comes as a `customer.subscription.updated` with the status `past_due`, which moves the
 * status off `active` and ends the grace at once.
 */
export const RENEWAL_GRACE_MS = DAY_MS;

/** A subscription in good standing with no cancellation ahead: one that will renew when its period ends. */
export function renewing(row: PlanRow): boolean {
  return row.source === 'stripe' && row.subscriptionStatus === 'active' && row.cancelsAt === null;
}

/**
 * When the account turns read-only unless something changes first: `plan_until`, or
 * a renewing subscription's end plus the grace. Null for a plan with no end. What
 * `planStateOf` decides on, and what the page is told so it locks at the same instant.
 */
export function readOnlyAtOf(row: PlanRow): number | null {
  if (row.planUntil === null) return null;
  return renewing(row) ? row.planUntil + RENEWAL_GRACE_MS : row.planUntil;
}

/**
 * What the account is at `now`: the row's word, unless its end has passed. A missing row
 * is a trial that starts now: `planFor` writes it, and a reader that reaches here with
 * null (the first request after sign-up, a hook that failed) is told what it would read
 * once it has.
 */
export function planStateOf(row: PlanRow | null, now: number): PlanState {
  if (!row) return 'trial';
  if (row.plan === 'inactive') return 'inactive';
  const readOnlyAt = readOnlyAtOf(row);
  if (readOnlyAt !== null && readOnlyAt <= now) return 'inactive';
  return row.plan;
}

/**
 * Whether no plan holds at `now`: a trial, a subscription or a comp that ended. Such an
 * account is on the free plan, and is `free` or `inactive` by what it holds
 * (`accountStateOf`); `planStateOf` alone cannot say which, since the row knows nothing
 * of the account's notes.
 */
export function lapsed(row: PlanRow | null, now: number): boolean {
  return planStateOf(row, now) === 'inactive';
}

/** The row as the Plan page reads it. `usedBytes` is the store's and added by the route. */
export function accountPlanOf(row: PlanRow, now: number): AccountPlan {
  const state = planStateOf(row, now);
  const subscription = row.source === 'stripe' && row.subscriptionStatus;
  return {
    state,
    until: row.planUntil,
    // By the row's word when it says inactive (the operator's end, dated now) and
    // otherwise where the end falls, which for a renewing subscription whose grace ran
    // out is the grace's end, the instant it did turn read-only.
    readOnlyAt: row.plan === 'inactive' ? row.planUntil : readOnlyAtOf(row),
    source: row.source,
    storageGb: row.storageGb,
    subscription: subscription
      ? {
          status: row.subscriptionStatus!,
          // A cancellation still ahead: the one asked for while Stripe has the
          // subscription `active`, or, once it has taken effect and the status is
          // `canceled`, the end of the period that was paid for, which the account keeps
          // until it passes. Null once that has passed too: nothing is ahead.
          cancelsAt:
            row.cancelsAt ??
            (row.subscriptionStatus === 'canceled' && row.planUntil !== null && row.planUntil > now ? row.planUntil : null),
          // `unpaid` is where Stripe leaves a subscription whose retries ran out when the
          // account is set to keep it rather than cancel: still a renewal not collected.
          pastDue: row.subscriptionStatus === 'past_due' || row.subscriptionStatus === 'unpaid',
        }
      : null,
  };
}

/** The account's row, or null for one that has none yet. */
export async function planRow(db: D1Database, userId: string): Promise<PlanRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM account_plan WHERE user_id = ?1`).bind(userId).first<RawRow>();
  return row ? toRow(row) : null;
}

/** The row a provider's customer id names, for the webhook; null for an id no row holds. */
export async function planRowByCustomer(db: D1Database, customerId: string): Promise<PlanRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM account_plan WHERE billing_customer_id = ?1`).bind(customerId).first<RawRow>();
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
    customerId: null,
    subscriptionId: null,
    subscriptionStatus: null,
    cancelsAt: null,
    eventAt: null,
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
  customerId?: string | null;
  subscriptionId?: string | null;
  subscriptionStatus?: string | null;
  cancelsAt?: number | null;
  eventAt?: string | null;
  lapseNotifiedAt?: number | null;
}

const COLUMN_OF: Record<keyof PlanPatch, string> = {
  plan: 'plan',
  planUntil: 'plan_until',
  storageGb: 'storage_gb',
  source: 'source',
  customerId: 'billing_customer_id',
  subscriptionId: 'billing_subscription_id',
  subscriptionStatus: 'billing_status',
  cancelsAt: 'billing_cancels_at',
  eventAt: 'billing_event_at',
  lapseNotifiedAt: 'lapse_notified_at',
};

/** How a plan row is written, besides the patch itself. */
export interface PlanUpdateOpts {
  /**
   * Apply only while the row's newest event is not after this stamp. The webhook's
   * guard against an event delivered late: a newer snapshot already on the row stands,
   * and the late one writes nothing.
   */
  notBefore?: string;
  /**
   * Apply only while the row still names this subscription. A refund cancel uses it so
   * a checkout that lands in the same moment is not written back to the subscription we
   * just ended.
   */
  onlyIfSubscription?: string;
  /**
   * Write `billing_event_at` only when the row's stamp is not already later. A refund
   * cancel is stamped with the refund, which is earlier than the
   * `customer.subscription.deleted` our cancel call causes; rolling the stamp back to
   * the refund would then let a late snapshot from before the cancel put the paid
   * period back.
   */
  advanceStamp?: boolean;
}

/**
 * The update as a statement, for a caller that batches it with something else: the
 * webhook, with the event's own row. `notBefore` is the webhook's guard against an event
 * delivered late: with it, the update applies only while the row's newest event is not
 * after this one, and an older event arriving after a newer one changes nothing.
 */
export function updatePlanStatement(
  db: D1Database,
  userId: string,
  patch: PlanPatch,
  now: number,
  opts: PlanUpdateOpts = {},
): D1PreparedStatement {
  const { sql, binds } = planUpdateSql(userId, patch, now, opts);
  return db.prepare(sql).bind(...binds);
}

/**
 * The SQL `updatePlanStatement` prepares. Exported so the refund-cancel write can be
 * checked without a D1: the CASE and the subscription guard are the whole fix, and a
 * placeholder off by one would apply the cancel to the wrong row or regress the stamp.
 */
export function planUpdateSql(userId: string, patch: PlanPatch, now: number, opts: PlanUpdateOpts = {}): { sql: string; binds: unknown[] } {
  const sets: string[] = ['updated_at = ?2'];
  const binds: unknown[] = [userId, now];
  for (const key of Object.keys(patch) as Array<keyof PlanPatch>) {
    const value = patch[key];
    if (value === undefined) continue;
    binds.push(value);
    const i = binds.length;
    if (key === 'eventAt' && opts.advanceStamp) {
      sets.push(`billing_event_at = CASE WHEN billing_event_at IS NULL OR billing_event_at <= ?${i} THEN ?${i} ELSE billing_event_at END`);
      continue;
    }
    sets.push(`${COLUMN_OF[key]} = ?${i}`);
  }
  let where = 'user_id = ?1';
  if (opts.onlyIfSubscription !== undefined) {
    binds.push(opts.onlyIfSubscription);
    where += ` AND billing_subscription_id = ?${binds.length}`;
  }
  if (opts.notBefore !== undefined) {
    binds.push(opts.notBefore);
    where += ` AND (billing_event_at IS NULL OR billing_event_at <= ?${binds.length})`;
  }
  return { sql: `UPDATE account_plan SET ${sets.join(', ')} WHERE ${where}`, binds };
}

export async function updatePlan(db: D1Database, userId: string, patch: PlanPatch, now = Date.now()): Promise<void> {
  await updatePlanStatement(db, userId, patch, now).run();
}

/**
 * The accounts whose plan has run out and have not been told, oldest end first: what the
 * sweep mails (lib/plan-mail.ts). A range on `idx_account_plan_lapse_due`, whose
 * conditions this repeats word for word so the planner takes it; `migrations.test.ts`
 * pins the plan. A renewing subscription is left out until its grace is up too
 * (`RENEWAL_GRACE_MS`): its end has passed and its renewal's webhook has not landed,
 * which is the hour a paying customer must not be told their subscription ended. The
 * same rule as `planStateOf`, spelled in SQL, as a filter on the rows the range finds.
 * `IS`, not `=`: a trial's `source` and `billing_status` are NULL, and `NOT (NULL AND …)`
 * is NULL, which drops the row: every trial's mail waited out the grace until
 * `migrations.test.ts` ran the statement against real rows. Binds: now, the most to
 * take, and now less the grace.
 */
export const LAPSE_DUE_SQL = `SELECT p.user_id, p.plan, p.plan_until, p.source, p.billing_status, u.email
    FROM account_plan p JOIN user u ON u.id = p.user_id
   WHERE p.lapse_notified_at IS NULL AND p.plan_until IS NOT NULL AND p.plan <> 'inactive'
     AND p.plan_until <= ?1
     AND NOT (p.source IS 'stripe' AND p.billing_status IS 'active' AND p.billing_cancels_at IS NULL AND p.plan_until > ?3)
   ORDER BY p.plan_until LIMIT ?2`;
