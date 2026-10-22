import { describe, expect, it } from 'vitest';
import { HANDLED_EVENTS, eventStamp, planPatchFor, refundEffectOf, refundPatchFor, storageGbOf, type StripeEvent } from './billing-events.js';
import type { StripeCharge, StripeConfig, StripeDispute, StripeInvoice, StripeSubscription } from './stripe.js';
import type { PlanRow } from './plan.js';

const stripe: StripeConfig = {
  secretKey: 'sk_test_x',
  webhookSecret: 'whsec_x',
  planPriceId: 'price_plan',
  storagePriceId: 'price_storage',
  environment: 'test',
  apiUrl: 'https://api.stripe.com',
};

/** Unix seconds, as Stripe stamps things. */
const T0 = Math.floor(Date.UTC(2026, 9, 10, 12) / 1000);
const T1 = T0 + 5;
const NEXT_YEAR = Math.floor(Date.UTC(2027, 9, 10, 12) / 1000);
const ms = (s: number) => s * 1000;

const row: PlanRow = {
  userId: 'u',
  plan: 'trial',
  planUntil: Date.parse('2026-10-20T00:00:00Z'),
  storageGb: 10,
  source: null,
  customerId: 'cus_1',
  subscriptionId: null,
  subscriptionStatus: null,
  cancelsAt: null,
  eventAt: null,
  lapseNotifiedAt: Date.parse('2026-10-01T00:00:00Z'),
  createdAt: 0,
  updatedAt: 0,
};

const planItem = { id: 'si_plan', price: { id: 'price_plan' }, quantity: 1, current_period_start: T0, current_period_end: NEXT_YEAR };
const storageItem = (quantity: number) => ({ id: 'si_storage', price: { id: 'price_storage' }, quantity, current_period_start: T0, current_period_end: NEXT_YEAR });

function sub(over: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    created: T0,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    metadata: { user_id: 'u' },
    items: { data: [planItem], has_more: false },
    ...over,
  };
}

/** A canceled snapshot: Stripe keeps the items, with the period they were last billed for. */
const canceledSub = (over: Partial<StripeSubscription> = {}) => sub({ status: 'canceled', canceled_at: T1, ...over });

function invoice(over: Partial<StripeInvoice> = {}, lines = [{ price: 'price_plan', amount: 6000, tax: 480 }]): StripeInvoice {
  return {
    id: 'in_1',
    customer: 'cus_1',
    status: 'paid',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
    lines: {
      data: lines.map((l, i) => ({
        id: `il_${i}`,
        amount: l.amount,
        quantity: 1,
        pricing: { price_details: { price: l.price } },
        taxes: [{ amount: l.tax }],
        period: { start: T0, end: NEXT_YEAR },
      })),
      has_more: false,
    },
    ...over,
  };
}

const event = (type: string, object: StripeEvent['data']['object'], created = T0): StripeEvent => ({ id: 'evt_1', type, created, data: { object } });

describe('planPatchFor', () => {
  it('makes a new subscription the plan, to the end of what it paid for', () => {
    expect(planPatchFor(stripe, event('customer.subscription.created', sub()), row)).toEqual({
      plan: 'active',
      source: 'stripe',
      planUntil: ms(NEXT_YEAR),
      storageGb: 10,
      subscriptionId: 'sub_1',
      subscriptionStatus: 'active',
      cancelsAt: null,
      eventAt: eventStamp(T0),
      lapseNotifiedAt: null,
    });
    expect(eventStamp(T0)).toBe('2026-10-10T12:00:00.000Z');
  });

  it('counts the storage the add-ons buy', () => {
    const items = [planItem, storageItem(2)];
    expect(storageGbOf(stripe, items)).toBe(60);
    expect(planPatchFor(stripe, event('customer.subscription.updated', sub({ items: { data: items, has_more: false } })), row)?.storageGb).toBe(60);
  });

  it('keeps a cancellation asked for ahead as the date, with the subscription still active', () => {
    const atEnd = sub({ cancel_at_period_end: true, cancel_at: NEXT_YEAR });
    const patch = planPatchFor(stripe, event('customer.subscription.updated', atEnd), row)!;
    expect(patch.subscriptionStatus).toBe('active');
    expect(patch.cancelsAt).toBe(ms(NEXT_YEAR));
    expect(patch.planUntil).toBe(ms(NEXT_YEAR));
    // Older API versions set only the flag; the period's end is then the date.
    expect(planPatchFor(stripe, event('customer.subscription.updated', sub({ cancel_at_period_end: true })), row)?.cancelsAt).toBe(ms(NEXT_YEAR));
    const dated = sub({ cancel_at: T1 + 86_400 });
    expect(planPatchFor(stripe, event('customer.subscription.updated', dated), row)?.cancelsAt).toBe(ms(T1 + 86_400));
  });

  it('leaves a canceled subscription its paid period, which the row already holds', () => {
    const paid: PlanRow = { ...row, plan: 'active', source: 'stripe', subscriptionId: 'sub_1', subscriptionStatus: 'active', planUntil: ms(NEXT_YEAR) };
    const patch = planPatchFor(stripe, event('customer.subscription.deleted', canceledSub(), T1), paid)!;
    expect(patch.plan).toBe('active');
    expect(patch.planUntil).toBe(ms(NEXT_YEAR));
    expect(patch.subscriptionStatus).toBe('canceled');
    expect(patch.cancelsAt).toBeNull();
    // A row that never had a period ends at the event.
    expect(planPatchFor(stripe, event('customer.subscription.deleted', canceledSub(), T1), { ...row, planUntil: null })?.planUntil).toBe(ms(T1));
  });

  it('keeps a past-due subscription to the end of the last period paid for, not the one whose renewal failed', () => {
    const paidTo = ms(T0);
    const paid: PlanRow = { ...row, plan: 'active', source: 'stripe', subscriptionId: 'sub_1', subscriptionStatus: 'active', planUntil: paidTo };
    // Stripe moves the period on at the failed renewal; the account does not move with it.
    const unpaid = sub({ status: 'past_due' });
    const patch = planPatchFor(stripe, event('customer.subscription.updated', unpaid, T1), paid)!;
    expect(patch.subscriptionStatus).toBe('past_due');
    expect(patch.planUntil).toBe(paidTo);
    expect('lapseNotifiedAt' in patch).toBe(false);
    // `unpaid` is where retries that ran out leave it when the account keeps it: the same.
    expect(planPatchFor(stripe, event('customer.subscription.updated', sub({ status: 'unpaid' }), T1), paid)?.planUntil).toBe(paidTo);
    // And when dunning gives up and cancels, the same end stands.
    expect(planPatchFor(stripe, event('customer.subscription.deleted', canceledSub(), NEXT_YEAR), { ...paid, subscriptionStatus: 'past_due' })?.planUntil).toBe(paidTo);
    // A renewal that goes through afterwards moves it.
    expect(planPatchFor(stripe, event('customer.subscription.updated', sub(), NEXT_YEAR), { ...paid, subscriptionStatus: 'past_due' })?.planUntil).toBe(ms(NEXT_YEAR));
  });

  it('ignores a subscription whose first payment has not gone through', () => {
    expect(planPatchFor(stripe, event('customer.subscription.created', sub({ status: 'incomplete' })), row)).toBeNull();
    expect(planPatchFor(stripe, event('customer.subscription.updated', sub({ status: 'incomplete_expired' })), row)).toBeNull();
  });

  it('takes a new subscription over a lapsed one from the invoice that paid for it', () => {
    const lapsed: PlanRow = {
      ...row,
      plan: 'active',
      source: 'stripe',
      subscriptionId: 'sub_old',
      subscriptionStatus: 'canceled',
      cancelsAt: Date.parse('2026-09-01T00:00:00Z'),
      planUntil: Date.parse('2026-09-01T00:00:00Z'),
    };
    const paidInvoice = invoice({ parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_new' } } });
    expect(planPatchFor(stripe, event('invoice.paid', paidInvoice), lapsed)).toMatchObject({
      plan: 'active',
      planUntil: ms(NEXT_YEAR),
      subscriptionId: 'sub_new',
      subscriptionStatus: 'active',
      cancelsAt: null,
    });
  });

  it('activates from a paid invoice when it arrives first, and defers the rest to the subscription', () => {
    const paidInvoice = invoice({}, [
      { price: 'price_plan', amount: 6000, tax: 480 },
      { price: 'price_storage', amount: 1200, tax: 96 },
    ]);
    expect(planPatchFor(stripe, event('invoice.paid', paidInvoice), row)).toEqual({
      plan: 'active',
      source: 'stripe',
      planUntil: ms(NEXT_YEAR),
      subscriptionId: 'sub_1',
      subscriptionStatus: 'active',
      cancelsAt: null,
      lapseNotifiedAt: null,
    });
    // Once the subscription is known, a proration's invoice names nothing new.
    const known: PlanRow = { ...row, subscriptionId: 'sub_1', subscriptionStatus: 'active' };
    const patch = planPatchFor(stripe, event('invoice.paid', paidInvoice), known)!;
    expect(patch.subscriptionId).toBeUndefined();
    expect(patch.storageGb).toBeUndefined();
    // A one-off invoice is not the plan's.
    expect(planPatchFor(stripe, event('invoice.paid', invoice({ parent: null })), row)).toBeNull();
  });

  /**
   * The subscription event for a checkout can be stamped the second before its invoice
   * is paid. An invoice that stamped the row would have the guard refuse that event as
   * older, and the storage it alone carries would never land.
   */
  it('leaves the event stamp to the subscription events, so the one behind an invoice still applies', () => {
    expect(planPatchFor(stripe, event('invoice.paid', invoice(), T1), row)).not.toHaveProperty('eventAt');
    expect(planPatchFor(stripe, event('customer.subscription.created', sub(), T0), row)).toMatchObject({ eventAt: eventStamp(T0) });
  });

  /**
   * A former subscriber who is comped keeps their customer id, so the webhook finds the
   * row; and a person who lapsed and subscribed again has an old subscription whose late
   * news must not take the row back.
   */
  it('leaves a comped account alone, and a live subscription to its own events', () => {
    const comped: PlanRow = { ...row, plan: 'active', source: 'comp', planUntil: null, subscriptionId: 'sub_old', subscriptionStatus: 'canceled' };
    expect(planPatchFor(stripe, event('customer.subscription.updated', canceledSub({ id: 'sub_old' })), comped)).toBeNull();
    expect(planPatchFor(stripe, event('customer.subscription.created', sub({ id: 'sub_new' })), comped)).toBeNull();
    // A comp that has ended is a lapsed account, and a new subscription is its way back.
    const ended: PlanRow = { ...comped, plan: 'inactive', planUntil: Date.parse('2026-10-01T00:00:00Z') };
    expect(planPatchFor(stripe, event('customer.subscription.created', sub({ id: 'sub_new' })), ended)).toMatchObject({ plan: 'active', source: 'stripe', subscriptionId: 'sub_new' });
    const dated: PlanRow = { ...comped, plan: 'active', planUntil: Date.parse('2026-10-01T00:00:00Z') };
    expect(planPatchFor(stripe, event('customer.subscription.created', sub({ id: 'sub_new' })), dated)).not.toBeNull();

    const live: PlanRow = { ...row, plan: 'active', source: 'stripe', subscriptionId: 'sub_new', subscriptionStatus: 'active' };
    expect(planPatchFor(stripe, event('customer.subscription.deleted', canceledSub({ id: 'sub_old' })), live)).toBeNull();
    const oldInvoice = invoice({ parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_old' } } });
    expect(planPatchFor(stripe, event('invoice.paid', oldInvoice), live)).toBeNull();
    expect(planPatchFor(stripe, event('customer.subscription.updated', sub({ id: 'sub_new' })), live)).not.toBeNull();
  });

  it('ignores what it does not follow', () => {
    expect(planPatchFor(stripe, event('customer.subscription.trial_will_end', sub()), row)).toBeNull();
    expect(planPatchFor(stripe, event('customer.updated', sub()), row)).toBeNull();
    expect(planPatchFor(stripe, event('invoice.payment_failed', invoice()), row)).toBeNull();
  });
});

/**
 * A refund in Stripe leaves the subscription renewing; the terms say it does not. These
 * are the rules that keep the terms' word, on the charge alone and on the invoice's
 * lines once the webhook has read it.
 */
describe('refundEffectOf', () => {
  const paid: PlanRow = { ...row, plan: 'active', source: 'stripe', subscriptionId: 'sub_1', subscriptionStatus: 'active', planUntil: ms(NEXT_YEAR) };
  // The invoice as a read of it names its lines: the plan, and two units of storage, with tax.
  const withStorage = invoice({}, [
    { price: 'price_plan', amount: 6000, tax: 480 },
    { price: 'price_storage', amount: 2400, tax: 192 },
  ]);
  function refund(over: Partial<StripeCharge> = {}): StripeCharge {
    return { id: 'ch_1', amount: 9072, amount_refunded: 9072, refunded: true, payment_intent: 'pi_1', customer: 'cus_1', ...over };
  }
  const dispute: StripeDispute = { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 9072, status: 'needs_response' };

  it('asks for the invoice first, since the charge names no subscription', () => {
    expect(refundEffectOf(stripe, event('charge.refunded', refund()), paid)).toBe('needs-invoice');
    expect(refundEffectOf(stripe, event('charge.dispute.created', dispute), paid)).toBe('needs-invoice');
  });

  it('cancels the subscription for a refund of the whole charge, and for a chargeback of any amount', () => {
    expect(refundEffectOf(stripe, event('charge.refunded', refund()), paid, withStorage)).toBe('cancel');
    expect(refundEffectOf(stripe, event('charge.refunded', refund({ refunded: false, amount_refunded: 9072 })), paid, withStorage)).toBe('cancel');
    expect(refundEffectOf(stripe, event('charge.dispute.created', { ...dispute, amount: 100 }), paid, withStorage)).toBe('cancel');
  });

  it("reads a partial refund by the add-on's lines, tax included", () => {
    // The add-on's two units with their tax come to 2592; a refund of that or less is the add-on's.
    const ofStorage = refund({ refunded: false, amount_refunded: 2592 });
    expect(refundEffectOf(stripe, event('charge.refunded', ofStorage), paid, withStorage)).toBe('remove-storage');
    expect(refundEffectOf(stripe, event('charge.refunded', refund({ refunded: false, amount_refunded: 1296 })), paid, withStorage)).toBe('remove-storage');
    // More than the add-on's lines is a refund of the plan, which cannot be told from one of both.
    expect(refundEffectOf(stripe, event('charge.refunded', refund({ refunded: false, amount_refunded: 2593 })), paid, withStorage)).toBe('cancel');
    // A partial refund on a subscription with no add-on can only be the plan's.
    expect(refundEffectOf(stripe, event('charge.refunded', refund({ refunded: false, amount_refunded: 100 })), paid, invoice())).toBe('cancel');
  });

  it('does nothing for a refund that is not of this subscription, of nothing, or not a refund', () => {
    // A one-off charge, whose payment paid no subscription's invoice.
    expect(refundEffectOf(stripe, event('charge.refunded', refund()), paid, null)).toBeNull();
    expect(refundEffectOf(stripe, event('charge.refunded', refund()), paid, invoice({ parent: null }))).toBeNull();
    // A former subscription's late refund.
    const old = invoice({ parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_old' } } });
    expect(refundEffectOf(stripe, event('charge.refunded', refund()), paid, old)).toBeNull();
    // A row that never subscribed.
    expect(refundEffectOf(stripe, event('charge.refunded', refund()), row)).toBeNull();
    // A charge with nothing refunded on it yet.
    expect(refundEffectOf(stripe, event('charge.refunded', refund({ refunded: false, amount_refunded: 0 })), paid)).toBeNull();
    // A comped account is not Stripe's to move.
    expect(refundEffectOf(stripe, event('charge.refunded', refund()), { ...paid, source: 'comp', planUntil: null })).toBeNull();
    expect(refundEffectOf(stripe, event('customer.subscription.updated', sub()), paid)).toBeNull();
  });

  /** The same refund delivered again finds the row as the first delivery left it, and does nothing. */
  it('finds nothing to do once the first delivery has cancelled the subscription', () => {
    const first = event('charge.refunded', refund(), T1);
    expect(refundEffectOf(stripe, first, paid, withStorage)).toBe('cancel');
    const after: PlanRow = { ...paid, ...refundPatchFor('cancel', first) } as PlanRow;
    expect(refundEffectOf(stripe, first, after)).toBeNull();
    // And the cancel the first delivery caused keeps the refund's date, not the year's end.
    expect(planPatchFor(stripe, event('customer.subscription.deleted', canceledSub(), NEXT_YEAR), after)?.planUntil).toBe(ms(T1));
  });

  /**
   * The cancel went through at Stripe but its answer was lost, so the first delivery
   * wrote nothing, and `customer.subscription.deleted` left the year's end on the row.
   * The redelivery still has the period to end, and only an add-on refund has nothing
   * left to change on a subscription that is already canceled.
   */
  it('still ends the period on redelivery when the cancel landed and the refund was never written', () => {
    const first = event('charge.refunded', refund(), T1);
    const canceled = event('customer.subscription.deleted', canceledSub({ canceled_at: NEXT_YEAR }), NEXT_YEAR);
    const afterCanceled = { ...paid, ...planPatchFor(stripe, canceled, paid) } as PlanRow;
    expect(afterCanceled.planUntil).toBe(paid.planUntil);
    expect(refundEffectOf(stripe, first, afterCanceled, withStorage)).toBe('cancel');
    const ofStorage = refund({ refunded: false, amount_refunded: 2592 });
    expect(refundEffectOf(stripe, event('charge.refunded', ofStorage, T1), afterCanceled, withStorage)).toBeNull();
  });

  /**
   * `planPatchFor` on a canceled snapshot keeps `planUntil` as the last paid period,
   * which is right for a cancel at the period's end. The refund's patch is what ends
   * it now. If that cancel lands first (the race the webhook used to lose), the
   * refund must still overwrite the date without needing a newer stamp.
   */
  it('still ends the paid period when the cancel event lands before the refund patch', () => {
    const refundAt = event('charge.refunded', refund(), T1);
    const canceledAt = event('customer.subscription.deleted', canceledSub({ canceled_at: NEXT_YEAR }), NEXT_YEAR);
    const afterCanceled = { ...paid, ...planPatchFor(stripe, canceledAt, paid) } as PlanRow;
    expect(afterCanceled.planUntil).toBe(paid.planUntil);
    expect(afterCanceled.eventAt).toBe(eventStamp(NEXT_YEAR));
    const refunded = refundPatchFor('cancel', refundAt);
    // The write keeps the later stamp (`advanceStamp`, run on real rows in migrations.test.ts).
    const afterRefund = { ...afterCanceled, ...refunded, eventAt: afterCanceled.eventAt };
    expect(afterRefund.planUntil).toBe(ms(T1));
    expect(afterRefund.subscriptionStatus).toBe('canceled');
    expect(planPatchFor(stripe, canceledAt, afterRefund)?.planUntil).toBe(ms(T1));
  });

  it('writes the row as the refund leaves the subscription', () => {
    expect(refundPatchFor('cancel', event('charge.refunded', refund(), T1))).toEqual({
      plan: 'active',
      source: 'stripe',
      planUntil: ms(T1),
      subscriptionStatus: 'canceled',
      cancelsAt: null,
      eventAt: eventStamp(T1),
    });
    expect(refundPatchFor('remove-storage', event('charge.refunded', refund(), T1))).toEqual({ storageGb: 10, eventAt: eventStamp(T1) });
  });

  it('is among the events the endpoint is asked for', () => {
    expect(HANDLED_EVENTS).toContain('charge.refunded');
    expect(HANDLED_EVENTS).toContain('charge.dispute.created');
    expect(HANDLED_EVENTS).toContain('invoice.paid');
  });
});
