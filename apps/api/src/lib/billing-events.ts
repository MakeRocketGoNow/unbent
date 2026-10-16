import { BASE_STORAGE_GB, STORAGE_ADDON_GB } from '@unbent/shared';
import type { PaddleAdjustment, PaddleConfig, PaddleLineItem, PaddleSubscription, PaddleTransaction } from './paddle.js';
import type { PlanPatch, PlanRow } from './plan.js';

/**
 * What a Paddle event does to a plan row (MAK-108): the pure half of the webhook, so the
 * rules are tested without a request or a database. The route (routes/billing.ts) finds
 * the row by the event's customer id, asks this for the patch, and writes it.
 *
 * Every patch is absolute (the status, the end date, the storage as they stand), never
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
  data: PaddleSubscription | PaddleTransaction | PaddleAdjustment;
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

/**
 * The adjustment events a refund arrives on. `adjustment.created` carries a refund made
 * with its approval (a sandbox refund, a live one Paddle approves at once, a chargeback)
 * and one still `pending_approval`; `adjustment.updated` is the approval or the
 * rejection of the latter. Both are read for the same thing (an approved refund), and
 * the row never follows a pending one, so a refund Paddle rejects changes nothing.
 */
export const ADJUSTMENT_EVENTS: ReadonlySet<string> = new Set(['adjustment.created', 'adjustment.updated']);

/** Which events the destination is asked for, for the setup notes and the operator's check. */
export const HANDLED_EVENTS: readonly string[] = [...SUBSCRIPTION_EVENTS, 'transaction.completed', ...ADJUSTMENT_EVENTS];

/** A comp still in force at `at`: `source` stays `comp` after one ends, so the dates say. */
function compRunning(row: PlanRow, at: number): boolean {
  return row.source === 'comp' && row.plan !== 'inactive' && (row.planUntil === null || row.planUntil > at);
}

/** Whether news of `subscriptionId` is the row's to take: it names the row's subscription, or the row's is canceled or none. */
function theRows(row: PlanRow, subscriptionId: string): boolean {
  return !row.paddleSubscriptionId || row.paddleStatus === 'canceled' || row.paddleSubscriptionId === subscriptionId;
}

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
 * and a `canceled` one (a scheduled cancellation taking effect at the period's end, a
 * cancellation made effective at once, or dunning giving up) carries no period at all.
 * For those the end date the row already holds stands, which is the end of the last
 * period paid for; the account keeps that, and no more. A row that never had one (a
 * subscription that was never active) ends at the event.
 *
 * A completed transaction is the other way the first checkout reaches the row: Paddle
 * sends it and `subscription.created` for the same moment in no promised order, so
 * either makes the account active with the period the transaction covers. The
 * subscription it names replaces the row's when it is a different one: a subscriber
 * who lapsed and subscribed again has a new subscription, and the old canceled one must
 * not keep answering for the row. The storage is left to the subscription event, which
 * names the items as they stand; a proration's items name what was bought then, not the
 * whole. A transaction with no subscription is not the plan's.
 *
 * For that reason a transaction does not move the row's event stamp. The subscription
 * event for the same checkout happened a moment *before* the transaction completed, so
 * a transaction delivered first and stamped would have `notBefore` refuse the
 * subscription event as older, and with it the storage the person had just paid for,
 * which only the subscription event carries; `/billing/refresh` could not mend it
 * either, since the subscription's `updated_at` is older still. The stamp orders
 * subscription snapshots against each other, which is the one ordering that matters:
 * a transaction writes nothing a later subscription event does not write again.
 *
 * `lapseNotifiedAt` is cleared whenever a paid period is ahead, so an account that
 * lapses, pays and lapses again is told the second time too.
 *
 * Two events change nothing however new they are. One about a subscription that is not
 * the row's while the row's own is live: a former subscription's late news (a
 * `subscription.canceled` for the one a person lapsed from, arriving after they
 * subscribed again) would otherwise point the row back at the old subscription, and
 * the account's deletion, which cancels what the row names, would then leave the live
 * one charging. And any event while the account is comped: a comp keeps the customer id
 * of a former subscriber, so the webhook can find the row, and a comp is the operator's
 * word that the account is not Paddle's to move: the checkout route refuses a new
 * subscription while one runs for the same reason. Once the comp has ended the row is a
 * lapsed account like any other, and a new subscription's events are its way back.
 */
export function planPatchFor(paddle: PaddleConfig, event: PaddleEvent, row: PlanRow): PlanPatch | null {
  const at = ms(event.occurred_at) ?? Date.now();
  if (compRunning(row, at)) return null;
  if (SUBSCRIPTION_EVENTS.has(event.event_type)) {
    const sub = event.data as PaddleSubscription;
    if (!theRows(row, sub.id)) return null;
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
    if (!txn.subscription_id || !theRows(row, txn.subscription_id)) return null;
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

/**
 * What an approved refund does to the subscription it names (MAK-108): the terms say a
 * refunded plan is cancelled and does not renew, and nothing in Paddle keeps that:
 * a refund there is an adjustment on the transaction, and the subscription it was for
 * stays active and renews at the period's end. So the webhook ends it, with the same
 * call account deletion makes.
 *
 * `cancel` is a refund of the plan: the whole transaction (`type: 'full'`), or any line
 * of it that is the plan's price. The subscription is cancelled at once and the account
 * turns read-only from the refund, not from the period's end: the period was given
 * back. `remove-storage` is a refund of only the add-on's lines: the person keeps the
 * plan they paid for and the add-on comes off the subscription, with nothing billed and
 * nothing credited (`removeSubscriptionStorage`). All of it, not some units of it: an
 * adjustment names an amount of money against a line, never a quantity, so a partial
 * amount on the add-on's line cannot say which of three units it meant. `needs-transaction`
 * is a partial refund whose lines have not been read yet; the caller reads the
 * transaction and asks again with its `details.line_items`, which is where the
 * `txnitm_` ids an adjustment names are resolved to prices. A line the transaction does
 * not name (Paddle's own tax line, say) is read as the plan's, since a refund that
 * cannot be told apart from the plan's is cancelled rather than left renewing.
 *
 * A chargeback is the card issuer's refund and is read as one: a subscription that keeps
 * charging a disputed card is the worse outcome. Credits (`credit`) are not refunds
 * (money kept on the customer's balance for the next charge), and reversals undo
 * nothing here: a person whose chargeback Paddle won can subscribe again.
 *
 * Nothing for a refund with no subscription (a one-off charge), for one naming a
 * subscription that is not the row's live one (a former subscription's late refund, or
 * one the row already holds as canceled, which is also how a second delivery of the
 * same refund, or `adjustment.updated` after a `created` that was already approved,
 * finds nothing left to do), or while the account is comped, for `planPatchFor`'s
 * reasons.
 */
export type RefundEffect = 'cancel' | 'remove-storage' | 'needs-transaction';

export function refundEffectOf(paddle: PaddleConfig, event: PaddleEvent, row: PlanRow, lineItems?: PaddleLineItem[]): RefundEffect | null {
  if (!ADJUSTMENT_EVENTS.has(event.event_type)) return null;
  const adj = event.data as PaddleAdjustment;
  if (adj.action !== 'refund' && adj.action !== 'chargeback') return null;
  if (adj.status !== 'approved') return null;
  if (!adj.subscription_id || adj.subscription_id !== row.paddleSubscriptionId || row.paddleStatus === 'canceled') return null;
  if (compRunning(row, ms(event.occurred_at) ?? Date.now())) return null;
  if (adj.type === 'full') return 'cancel';
  if (!lineItems) return 'needs-transaction';
  const priceOf = new Map(lineItems.map((l) => [l.id, l.price_id]));
  const refundedPrices = adj.items.map((i) => priceOf.get(i.item_id));
  const onlyStorage = refundedPrices.length > 0 && refundedPrices.every((p) => p === paddle.storagePriceId);
  return onlyStorage ? 'remove-storage' : 'cancel';
}

/**
 * The row after a refund's effect has gone through at Paddle. A cancel ends the plan at
 * the refund (`planUntil` at the event, and the status Paddle will confirm), so the
 * `subscription.canceled` that follows, which carries no period, keeps that date rather
 * than the year's end the row held. Stamped with the adjustment's time: the cancel it
 * caused happened after it, so the confirming event still applies, and an older
 * subscription snapshot delivered late cannot put the period back. The storage goes
 * back to the base for the same reason, ahead of the `subscription.updated` that will
 * say the same.
 */
export function refundPatchFor(effect: Exclude<RefundEffect, 'needs-transaction'>, event: PaddleEvent): PlanPatch {
  const at = ms(event.occurred_at) ?? Date.now();
  if (effect === 'cancel') {
    return { plan: 'active', source: 'paddle', planUntil: at, paddleStatus: 'canceled', paddleCancelsAt: null, paddleEventAt: event.occurred_at };
  }
  return { storageGb: BASE_STORAGE_GB, paddleEventAt: event.occurred_at };
}
