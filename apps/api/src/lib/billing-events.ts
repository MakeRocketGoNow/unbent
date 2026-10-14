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
 * paid for, and the end date decides the rest. Only an event whose subscription is
 * `active` or `trialing` moves that date, since only those name a period that has been
 * paid for: a `past_due` subscription's current period is the one whose renewal failed,
 * and a `canceled` one — a scheduled cancellation taking effect at the period's end, a
 * cancellation made effective at once, or dunning giving up — carries no period at all.
 * For those the end date the row already holds stands, which is the end of the last
 * period paid for; the account keeps that, and no more. A row that never had one (a
 * subscription that was never active) ends at the event.
 *
 * A completed transaction is the other way the first checkout reaches the row: Paddle
 * sends it and `subscription.created` for the same moment in no promised order, so
 * either makes the account active with the period the transaction covers. The
 * subscription it names replaces the row's when it is a different one — a subscriber
 * who lapsed and subscribed again has a new subscription, and the old canceled one must
 * not keep answering for the row. The storage is left to the subscription event, which
 * names the items as they stand; a proration's items name what was bought then, not the
 * whole. A transaction with no subscription is not the plan's.
 *
 * For that reason a transaction does not move the row's event stamp. The subscription
 * event for the same checkout happened a moment *before* the transaction completed, so
 * a transaction delivered first and stamped would have `notBefore` refuse the
 * subscription event as older — and with it the storage the person had just paid for,
 * which only the subscription event carries; `/billing/refresh` could not mend it
 * either, since the subscription's `updated_at` is older still. The stamp orders
 * subscription snapshots against each other, which is the one ordering that matters:
 * a transaction writes nothing a later subscription event does not write again.
 *
 * `lapseNotifiedAt` is cleared whenever a paid period is ahead, so an account that
 * lapses, pays and lapses again is told the second time too.
 */
export function planPatchFor(paddle: PaddleConfig, event: PaddleEvent, row: PlanRow): PlanPatch | null {
  const at = ms(event.occurred_at) ?? Date.now();
  if (SUBSCRIPTION_EVENTS.has(event.event_type)) {
    const sub = event.data as PaddleSubscription;
    const paidFor = sub.status === 'active' || sub.status === 'trialing';
    const periodEnd = paidFor ? ms(sub.current_billing_period?.ends_at) : null;
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
    const newSubscription = txn.subscription_id !== row.paddleSubscriptionId;
    return {
      plan: 'active',
      source: 'paddle',
      ...(periodEnd !== null ? { planUntil: periodEnd } : {}),
      ...(newSubscription ? { paddleSubscriptionId: txn.subscription_id, paddleStatus: 'active', paddleCancelsAt: null } : {}),
      ...(periodEnd !== null && periodEnd > at ? { lapseNotifiedAt: null } : {}),
    };
  }
  return null;
}
