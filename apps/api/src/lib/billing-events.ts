import { BASE_STORAGE_GB, STORAGE_ADDON_GB } from '@unbent/shared';
import { periodEndOf, type StripeCharge, type StripeConfig, type StripeDispute, type StripeInvoice, type StripeInvoiceLine, type StripeSubscription } from './stripe.js';
import type { PlanPatch, PlanRow } from './plan.js';

/**
 * What a Stripe event does to a plan row (MAK-108): the pure half of the webhook, so the
 * rules are tested without a request or a database. The route (routes/billing.ts) finds
 * the row by the event's customer id, asks this for the patch, and writes it.
 *
 * Every patch is absolute (the status, the end date, the storage as they stand), never
 * an increment, so an event applied twice lands as it landed once. Stripe promises
 * delivery, not order, and retries for three days anything not answered 2xx; the route
 * refuses an event it has seen by id and `updatePlanStatement`'s `notBefore` keeps an
 * older event from writing over a newer one, so between the two a delivery can be late
 * or repeated and the row still ends where the newest event put it. The one exception
 * is a refund's cancel, which ends the period even under the newer stamp its own
 * `customer.subscription.deleted` left (`refundPatchFor`, and the webhook's comment).
 *
 * Stripe stamps an event with `created` in whole seconds, where Paddle gave
 * microseconds. Two events in the same second therefore order as equals, and both
 * apply (`notBefore` is "not after"); the snapshots a checkout fires in one second
 * agree with each other, so that costs nothing, and an event a second later still wins.
 */

export interface StripeEvent {
  id: string;
  type: string;
  /** When it happened, unix seconds. */
  created: number;
  data: { object: StripeSubscription | StripeInvoice | StripeCharge | StripeDispute };
}

/** An event's time as the row keeps and compares it: ISO 8601 at millisecond precision. */
export function eventStamp(created: number): string {
  return new Date(created * 1000).toISOString();
}

/** The subscription events the row follows. The rest (`customer.subscription.trial_will_end`, say) are ignored by name. */
export const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

/**
 * The events a refund arrives on. `charge.refunded` is a refund that went through,
 * whoever made it: the operator from the dashboard, or Stripe itself, which under
 * Managed Payments may refund a buyer within sixty days without asking. A
 * `charge.dispute.created` is the card issuer's refund, and is read as one.
 */
export const REFUND_EVENTS: ReadonlySet<string> = new Set(['charge.refunded', 'charge.dispute.created']);

/** Which events the endpoint is asked for, for the setup notes and the operator's check. */
export const HANDLED_EVENTS: readonly string[] = [...SUBSCRIPTION_EVENTS, 'invoice.paid', ...REFUND_EVENTS];

/** A comp still in force at `at`: `source` stays `comp` after one ends, so the dates say. */
function compRunning(row: PlanRow, at: number): boolean {
  return row.source === 'comp' && row.plan !== 'inactive' && (row.planUntil === null || row.planUntil > at);
}

/** Whether news of `subscriptionId` is the row's to take: it names the row's subscription, or the row's is canceled or none. */
function theRows(row: PlanRow, subscriptionId: string): boolean {
  return !row.subscriptionId || row.subscriptionStatus === 'canceled' || row.subscriptionId === subscriptionId;
}

/** The subscription an invoice bills, since 2025-03-31.basil under `parent`; null for an invoice that bills none. */
export function invoiceSubscriptionOf(invoice: StripeInvoice): string | null {
  return invoice.parent?.type === 'subscription_details' ? (invoice.parent.subscription_details?.subscription ?? null) : null;
}

/** The storage the subscription's add-ons buy: `BASE_STORAGE_GB` plus a block per unit. */
export function storageGbOf(stripe: StripeConfig, items: Array<{ price: { id: string }; quantity: number }>): number {
  const units = items.filter((i) => i.price.id === stripe.storagePriceId).reduce((n, i) => n + i.quantity, 0);
  return BASE_STORAGE_GB + STORAGE_ADDON_GB * units;
}

/**
 * The patch for `event` on `row`, or null for an event that changes nothing here.
 *
 * A subscription event carries the whole subscription, so the row is written from it
 * whole: Stripe's status, the end of the period paid for, the storage the items buy, and
 * a cancellation asked for ahead. The plan is `active` for as long as there is a period
 * paid for, and the end date decides the rest. Only an event whose subscription is
 * `active` or `trialing` moves that date, since only those name a period that has been
 * paid for: a `past_due` or `unpaid` subscription's current period is the one whose
 * renewal failed, and a `canceled` one (a cancellation at the period's end taking
 * effect, one made effective at once, or dunning giving up) is over. For those the end
 * date the row already holds stands, which is the end of the last period paid for; the
 * account keeps that, and no more. A row that never had one (a subscription that was
 * never active) ends at the event. An `incomplete` subscription, whose first payment
 * has not gone through, changes nothing: nothing has been paid for, and Checkout only
 * makes one for a payment method that settles later.
 *
 * A paid invoice is the other way the first checkout reaches the row: Stripe sends it
 * and `customer.subscription.created` for the same moment in no promised order, so
 * either makes the account active with the period the invoice's lines cover. The
 * subscription it names replaces the row's when it is a different one: a subscriber
 * who lapsed and subscribed again has a new subscription, and the old canceled one must
 * not keep answering for the row. The storage is left to the subscription event, which
 * names the items as they stand; a proration's invoice names what was bought then, not
 * the whole. An invoice that bills no subscription is not the plan's.
 *
 * For that reason an invoice does not move the row's event stamp. The subscription
 * event for the same checkout can be stamped the second before the invoice is paid, so
 * an invoice delivered first and stamped would have `notBefore` refuse the subscription
 * event as older, and with it the storage the person had just paid for, which only the
 * subscription event carries. The stamp orders subscription snapshots against each
 * other, which is the one ordering that matters: an invoice writes nothing a later
 * subscription event does not write again.
 *
 * `lapseNotifiedAt` is cleared whenever a paid period is ahead, so an account that
 * lapses, pays and lapses again is told the second time too.
 *
 * Two events change nothing however new they are. One about a subscription that is not
 * the row's while the row's own is live: a former subscription's late news (a
 * `customer.subscription.deleted` for the one a person lapsed from, arriving after they
 * subscribed again) would otherwise point the row back at the old subscription, and
 * the account's deletion, which cancels what the row names, would then leave the live
 * one charging. And any event while the account is comped: a comp keeps the customer id
 * of a former subscriber, so the webhook can find the row, and a comp is the operator's
 * word that the account is not Stripe's to move: the checkout route refuses a new
 * subscription while one runs for the same reason. Once the comp has ended the row is a
 * lapsed account like any other, and a new subscription's events are its way back.
 */
export function planPatchFor(stripe: StripeConfig, event: StripeEvent, row: PlanRow): PlanPatch | null {
  const at = event.created * 1000;
  if (compRunning(row, at)) return null;
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const sub = event.data.object as StripeSubscription;
    if (!theRows(row, sub.id)) return null;
    if (sub.status === 'incomplete' || sub.status === 'incomplete_expired') return null;
    const paidFor = sub.status === 'active' || sub.status === 'trialing';
    const periodEndSeconds = paidFor ? periodEndOf(sub) : null;
    const periodEnd = periodEndSeconds === null ? null : periodEndSeconds * 1000;
    const planUntil = periodEnd ?? row.planUntil ?? at;
    // A cancellation ahead while the subscription still runs: a dated one, or the
    // period's end when it is to cancel there (Stripe sets `cancel_at` for that too, but
    // not on every version). Nothing once it has taken effect.
    const cancelsAt =
      sub.status === 'canceled' ? null : sub.cancel_at !== null ? sub.cancel_at * 1000 : sub.cancel_at_period_end ? periodEnd : null;
    return {
      plan: 'active',
      source: 'stripe',
      planUntil,
      storageGb: storageGbOf(stripe, sub.items.data),
      subscriptionId: sub.id,
      subscriptionStatus: sub.status,
      cancelsAt,
      eventAt: eventStamp(event.created),
      ...(planUntil > at ? { lapseNotifiedAt: null } : {}),
    };
  }
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as StripeInvoice;
    const subscriptionId = invoiceSubscriptionOf(invoice);
    if (!subscriptionId || !theRows(row, subscriptionId)) return null;
    const ends = invoice.lines.data.map((l) => l.period.end).filter((n) => typeof n === 'number');
    const periodEnd = ends.length ? Math.max(...ends) * 1000 : null;
    const newSubscription = subscriptionId !== row.subscriptionId;
    return {
      plan: 'active',
      source: 'stripe',
      ...(periodEnd !== null ? { planUntil: periodEnd } : {}),
      ...(newSubscription ? { subscriptionId, subscriptionStatus: 'active', cancelsAt: null } : {}),
      ...(periodEnd !== null && periodEnd > at ? { lapseNotifiedAt: null } : {}),
    };
  }
  return null;
}

/**
 * What a refund does to the subscription it was for (MAK-108): the terms say a refunded
 * plan is cancelled and does not renew, and nothing in Stripe keeps that: a refund
 * there is money back on a charge, and the subscription the charge paid for stays
 * active and renews at the period's end. So the webhook ends it, with the same call
 * account deletion makes.
 *
 * `cancel` is a refund of the plan: the whole charge of an invoice that billed the
 * plan, or more than the add-on's lines came to. The subscription is cancelled at once
 * and the account turns read-only from the refund, not from the period's end: the
 * period was given back. `remove-storage`
 * is a refund of no more than the add-on's lines, with tax, on a subscription that has
 * the add-on: the person keeps the plan they paid for and the add-on comes off the
 * subscription, with nothing billed and nothing credited (`setSubscriptionStorage`
 * with `no-charge`). All of it, not some units of it: a refund names an amount, never
 * a line or a quantity, so a partial amount cannot say which of three units it meant,
 * and a refund that cannot be told apart from the plan's is cancelled rather than left
 * renewing. A storage-only invoice is the exception, since it names the units it added
 * (`storageKeptAfter`). `needs-invoice` is a refund whose invoice has not been read yet; the caller
 * finds the invoice through the charge's payment intent (`invoicesOfPayment`) and asks
 * again with it, since the charge itself names no subscription on this API version.
 *
 * A chargeback is the card issuer's refund and is read as one, whatever its amount: a
 * subscription that keeps charging a disputed card is the worse outcome. Stripe
 * handles the dispute itself under Managed Payments; a person whose chargeback it wins
 * can subscribe again.
 *
 * Nothing for a refund of a charge that paid no invoice (a one-off), for one whose
 * invoice bills a subscription that is not the row's (a former subscription's late
 * refund), for one whose subscription the row holds as canceled with its period already
 * ended by the refund (which is how a second delivery of the same refund finds nothing
 * left to do), or while the account is comped, for `planPatchFor`'s reasons.
 *
 * Canceled alone is not enough to call a refund done. The cancel can go through at
 * Stripe and its answer be lost (a timeout), so nothing is written here;
 * `customer.subscription.deleted` then lands and leaves the year's end on the row, and
 * the refund's redelivery is what has to end it. Only a period that already ends by the
 * refund says the patch is on the row. The cancel is asked for again in that case,
 * which `ensureSubscriptionCanceled` reads as done; an add-on refund on a canceled
 * subscription is nothing, since Stripe refuses to change one and every retry would
 * fail the same way.
 */
export type RefundEffect = 'cancel' | 'remove-storage' | 'needs-invoice';

export function refundEffectOf(stripe: StripeConfig, event: StripeEvent, row: PlanRow, invoice?: StripeInvoice | null): RefundEffect | null {
  if (!REFUND_EVENTS.has(event.type)) return null;
  const at = event.created * 1000;
  if (compRunning(row, at)) return null;
  if (!row.subscriptionId) return null;
  const canceled = row.subscriptionStatus === 'canceled';
  if (canceled && (row.planUntil === null || row.planUntil <= at)) return null;
  if (event.type === 'charge.refunded' && (event.data.object as StripeCharge).amount_refunded <= 0) return null;
  if (invoice === undefined) return 'needs-invoice';
  if (invoice === null || invoiceSubscriptionOf(invoice) !== row.subscriptionId) return null;
  if (event.type === 'charge.dispute.created') return 'cancel';
  const charge = event.data.object as StripeCharge;
  const addOn = invoice.lines.data.filter((l) => isAddOnLine(stripe, l));
  // An invoice that billed nothing but storage (the proration `/billing/storage` invoices
  // at once) is the add-on's to refund, all of it included: reading its whole-charge
  // refund as the plan's would end a year the person paid for and was not refunded.
  // `storageKeptAfter` then takes off only the units that invoice added.
  if (storageOnly(stripe, invoice)) return canceled ? null : 'remove-storage';
  if (charge.refunded || charge.amount_refunded >= charge.amount) return 'cancel';
  if (addOn.length === 0) return 'cancel';
  const addOnTotal = addOn.reduce((sum, l) => sum + l.amount + (l.taxes ?? []).reduce((t, tax) => t + tax.amount, 0), 0);
  if (charge.amount_refunded <= addOnTotal) return canceled ? null : 'remove-storage';
  return 'cancel';
}

const isAddOnLine = (stripe: StripeConfig, l: StripeInvoiceLine) => l.pricing?.price_details?.price === stripe.storagePriceId;

/** An invoice whose every billed line is the add-on's: a storage change, invoiced on its own. */
function storageOnly(stripe: StripeConfig, invoice: StripeInvoice): boolean {
  const addOn = invoice.lines.data.filter((l) => isAddOnLine(stripe, l));
  return addOn.length > 0 && invoice.lines.data.every((l) => isAddOnLine(stripe, l) || l.amount === 0);
}

/**
 * The add-on units to leave on a subscription that has `current` of them, once the
 * refund of `invoice` has gone through. Zero for a refund of the add-on on the year's
 * invoice: an amount cannot say which of the units it meant (`refundEffectOf`). A
 * storage-only invoice can: its proration has a line charging the new quantity and,
 * past the first block, one crediting the old, so it names the units it added, and only
 * those come off. The units bought before it were paid for on the year's invoice, which
 * was not refunded, and taking them too could leave the quota under what the account
 * holds. Absolute rather than a subtraction from whatever is there, so a redelivery
 * finds the units already gone and takes nothing more: while the subscription still has
 * the quantity the invoice charged for (or more, bought later), the added units come
 * off; below it, they already have.
 */
export function storageKeptAfter(stripe: StripeConfig, invoice: StripeInvoice | null, current: number): number {
  if (!invoice || !storageOnly(stripe, invoice)) return 0;
  const lines = invoice.lines.data.filter((l) => isAddOnLine(stripe, l));
  const charged = Math.max(0, ...lines.filter((l) => l.amount > 0).map((l) => l.quantity ?? 0));
  const credited = Math.max(0, ...lines.filter((l) => l.amount < 0).map((l) => l.quantity ?? 0));
  const added = charged - credited;
  if (added <= 0) return 0;
  return current >= charged ? current - added : current;
}

/**
 * The row after a refund's effect has gone through at Stripe. A cancel ends the plan at
 * the refund (`planUntil` at the event, and the status Stripe will confirm), so the
 * `customer.subscription.deleted` that follows, which carries no paid period, keeps
 * that date rather than the year's end the row held. Stamped with the refund's time:
 * the cancel it caused happened after it, so the confirming event still applies, and
 * an older subscription snapshot delivered late cannot put the period back. The
 * confirming event can also land first (Stripe fires it as the cancel call returns);
 * the webhook still writes this patch in that case, without rolling the stamp back,
 * because a canceled snapshot on its own keeps the year's end. The storage goes back
 * to the base for the same reason, ahead of the `customer.subscription.updated` that
 * will say the same; to the units `storageKeptAfter` left, for a storage-only invoice.
 */
export function refundPatchFor(effect: Exclude<RefundEffect, 'needs-invoice'>, event: StripeEvent, keptUnits = 0): PlanPatch {
  const at = event.created * 1000;
  if (effect === 'cancel') {
    return { plan: 'active', source: 'stripe', planUntil: at, subscriptionStatus: 'canceled', cancelsAt: null, eventAt: eventStamp(event.created) };
  }
  return { storageGb: BASE_STORAGE_GB + STORAGE_ADDON_GB * keptUnits, eventAt: eventStamp(event.created) };
}
