import { BASE_STORAGE_GB, STORAGE_ADDON_GB } from '@unbent/shared';
import type { PaddleConfig, PaddleSubscription, PaddleTransaction } from './paddle.js';
import type { PlanPatch, PlanRow } from './plan.js';

/**
 * What a Paddle event does to a plan row (MAK-108): the pure half of the webhook, so the
 * rules are tested without a request or a database. The route (routes/billing.ts) finds
 * the row by the event's customer id, asks this for the patch, and writes it.
 *
 * Every patch is absolute — the status, the end date, the storage as they stand — never
 * an increment, so an event applied twice lands as it landed once. Paddle promises
 * delivery, not order, and retries anything not answered in five seconds; the route
 * refuses an event it has seen by id and `updatePlanStatement`'s `notBefore` keeps an
 * older event from writing over a newer one, so between the two a delivery can be late
 * or repeated and the row still ends where the newest event put it.
 */

export interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: PaddleSubscription | PaddleTransaction;
}

/** The subscription events the row follows. The rest (`subscription.imported`, say) are ignored by name. */
export const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.trialing',
  'subscription.updated',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.canceled',
]);

/** Which events the destination is asked for, for the setup notes and the operator's check. */
export const HANDLED_EVENTS: readonly string[] = [...SUBSCRIPTION_EVENTS, 'transaction.completed'];

function ms(rfc3339: string | null | undefined): number | null {
  if (!rfc3339) return null;
  const t = Date.parse(rfc3339);
  return Number.isFinite(t) ? t : null;
}

/** The storage the subscription's add-ons buy: `BASE_STORAGE_GB` plus a block per unit. */
export function storageGbOf(paddle: PaddleConfig, items: Array<{ price: { id: string }; quantity: number; status?: string }>): number {
  const units = items
    .filter((i) => i.price.id === paddle.storagePriceId && i.status !== 'inactive')
    .reduce((n, i) => n + i.quantity, 0);
  return BASE_STORAGE_GB + STORAGE_ADDON_GB * units;
}

/**
 * The patch for `event` on `row`, or null for an event that changes nothing here.
 *
 * A subscription event carries the whole subscription, so the row is written from it
 * whole: Paddle's status, the end of the period paid for, the storage the items buy, and
 * a cancellation scheduled ahead. The plan is `active` for as long as there is a period
 * paid for — `canceled` and `paused` included, since the end date decides the rest:
 * Paddle sets `canceled` when a scheduled cancellation takes effect, at the period's end,
 * and a cancellation made effective at once still leaves the period paid for, which the
 * account keeps. Neither carries a period any more, so the end date the row already
 * holds stands, and a row that never had one (a subscription that was never active)
 * ends at the event.
 *
 * A completed transaction is the other way the first checkout reaches the row: Paddle
 * sends it and `subscription.created` for the same moment in no promised order, so
 * either makes the account active with the period the transaction covers, and the
 * subscription id if the row has none yet. The storage is left to the subscription
 * event, which names the items as they stand; a proration's items name what was bought
 * then, not the whole. A transaction with no subscription is not the plan's.
 *
 * `lapseNotifiedAt` is cleared whenever a paid period is ahead, so an account that
 * lapses, pays and lapses again is told the second time too.
 */
export function planPatchFor(paddle: PaddleConfig, event: PaddleEvent, row: PlanRow): PlanPatch | null {
  const at = ms(event.occurred_at) ?? Date.now();
  if (SUBSCRIPTION_EVENTS.has(event.event_type)) {
    const sub = event.data as PaddleSubscription;
    const periodEnd = ms(sub.current_billing_period?.ends_at);
    const planUntil = periodEnd ?? row.planUntil ?? at;
    return {
      plan: 'active',
      source: 'paddle',
      planUntil,
      storageGb: storageGbOf(paddle, sub.items),
      paddleSubscriptionId: sub.id,
      paddleStatus: sub.status,
      paddleCancelsAt: sub.scheduled_change?.action === 'cancel' ? ms(sub.scheduled_change.effective_at) : null,
      paddleEventAt: event.occurred_at,
      ...(planUntil > at ? { lapseNotifiedAt: null } : {}),
    };
  }
  if (event.event_type === 'transaction.completed') {
    const txn = event.data as PaddleTransaction;
    if (!txn.subscription_id) return null;
    const periodEnd = ms(txn.billing_period?.ends_at);
    return {
      plan: 'active',
      source: 'paddle',
      ...(periodEnd !== null ? { planUntil: periodEnd } : {}),
      ...(row.paddleSubscriptionId ? {} : { paddleSubscriptionId: txn.subscription_id }),
      ...(row.paddleStatus ? {} : { paddleStatus: 'active' }),
      paddleEventAt: event.occurred_at,
      ...(periodEnd !== null && periodEnd > at ? { lapseNotifiedAt: null } : {}),
    };
  }
  return null;
}
