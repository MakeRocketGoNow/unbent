import { describe, expect, it } from 'vitest';
import { HANDLED_EVENTS, planPatchFor, refundEffectOf, refundPatchFor, storageGbOf, type PaddleEvent } from './billing-events.js';
import type { PaddleAdjustment, PaddleConfig, PaddleSubscription, PaddleTransaction } from './paddle.js';
import type { PlanRow } from './plan.js';

const paddle: PaddleConfig = {
  apiKey: 'pdl_sdbx_apikey_x',
  webhookSecret: 's',
  clientToken: 't',
  planPriceId: 'pri_plan',
  storagePriceId: 'pri_storage',
  environment: 'sandbox',
  apiUrl: 'https://sandbox-api.paddle.com',
};

const T0 = '2026-10-10T12:00:00Z';
const T1 = '2026-10-10T12:00:05Z';
const NEXT_YEAR = '2027-10-10T12:00:00Z';

const row: PlanRow = {
  userId: 'u',
  plan: 'trial',
  planUntil: Date.parse('2026-10-20T00:00:00Z'),
  storageGb: 10,
  source: null,
  paddleCustomerId: 'ctm_1',
  paddleSubscriptionId: null,
  paddleStatus: null,
  paddleCancelsAt: null,
  paddleEventAt: null,
  lapseNotifiedAt: Date.parse('2026-10-01T00:00:00Z'),
  createdAt: 0,
  updatedAt: 0,
};

function sub(over: Partial<PaddleSubscription> = {}): PaddleSubscription {
  return {
    id: 'sub_1',
    status: 'active',
    customer_id: 'ctm_1',
    custom_data: { user_id: 'u' },
    current_billing_period: { starts_at: T0, ends_at: NEXT_YEAR },
    scheduled_change: null,
    items: [{ status: 'active', quantity: 1, price: { id: 'pri_plan' } }],
    canceled_at: null,
    ...over,
  };
}

const event = (event_type: string, data: PaddleSubscription | PaddleTransaction | PaddleAdjustment, occurred_at = T0): PaddleEvent => ({
  event_id: 'evt_1',
  event_type,
  occurred_at,
  data,
});

describe('planPatchFor', () => {
  it('makes a new subscription the plan, to the end of what it paid for', () => {
    expect(planPatchFor(paddle, event('subscription.created', sub()), row)).toEqual({
      plan: 'active',
      source: 'paddle',
      planUntil: Date.parse(NEXT_YEAR),
      storageGb: 10,
      paddleSubscriptionId: 'sub_1',
      paddleStatus: 'active',
      paddleCancelsAt: null,
      paddleEventAt: T0,
      lapseNotifiedAt: null,
    });
  });

  it('counts the storage the add-ons buy, and not an item Paddle has retired', () => {
    const items = [
      { status: 'active', quantity: 1, price: { id: 'pri_plan' } },
      { status: 'active', quantity: 2, price: { id: 'pri_storage' } },
      { status: 'inactive', quantity: 5, price: { id: 'pri_storage' } },
    ];
    expect(storageGbOf(paddle, items)).toBe(60);
    expect(planPatchFor(paddle, event('subscription.updated', sub({ items })), row)?.storageGb).toBe(60);
  });

  it('keeps a cancellation scheduled ahead as the date, with the subscription still active', () => {
    const scheduled = sub({ scheduled_change: { action: 'cancel', effective_at: NEXT_YEAR } });
    const patch = planPatchFor(paddle, event('subscription.updated', scheduled), row)!;
    expect(patch.paddleStatus).toBe('active');
    expect(patch.paddleCancelsAt).toBe(Date.parse(NEXT_YEAR));
    expect(patch.planUntil).toBe(Date.parse(NEXT_YEAR));
  });

  it('leaves a canceled subscription its paid period, which the row already holds', () => {
    const paid: PlanRow = { ...row, plan: 'active', source: 'paddle', paddleSubscriptionId: 'sub_1', paddleStatus: 'active', planUntil: Date.parse(NEXT_YEAR) };
    const canceled = sub({ status: 'canceled', current_billing_period: null, canceled_at: T1 });
    const patch = planPatchFor(paddle, event('subscription.canceled', canceled, T1), paid)!;
    expect(patch.plan).toBe('active');
    expect(patch.planUntil).toBe(Date.parse(NEXT_YEAR));
    expect(patch.paddleStatus).toBe('canceled');
    expect(patch.paddleCancelsAt).toBeNull();
    // A row that never had a period ends at the event.
    expect(planPatchFor(paddle, event('subscription.canceled', canceled, T1), { ...row, planUntil: null })?.planUntil).toBe(Date.parse(T1));
  });

  it('keeps a past-due subscription to the end of the last period paid for, not the one whose renewal failed', () => {
    const paidTo = Date.parse('2026-10-10T12:00:00Z');
    const paid: PlanRow = { ...row, plan: 'active', source: 'paddle', paddleSubscriptionId: 'sub_1', paddleStatus: 'active', planUntil: paidTo };
    // Paddle moves the period on at the failed renewal; the account does not move with it.
    const unpaid = sub({ status: 'past_due', current_billing_period: { starts_at: T0, ends_at: NEXT_YEAR } });
    const patch = planPatchFor(paddle, event('subscription.past_due', unpaid, T1), paid)!;
    expect(patch.paddleStatus).toBe('past_due');
    expect(patch.planUntil).toBe(paidTo);
    expect('lapseNotifiedAt' in patch).toBe(false);
    // And when dunning gives up, the same end stands.
    const gaveUp = sub({ status: 'canceled', current_billing_period: null });
    expect(planPatchFor(paddle, event('subscription.canceled', gaveUp, NEXT_YEAR), { ...paid, paddleStatus: 'past_due' })?.planUntil).toBe(paidTo);
    // A renewal that goes through afterwards moves it.
    expect(planPatchFor(paddle, event('subscription.updated', sub(), NEXT_YEAR), { ...paid, paddleStatus: 'past_due' })?.planUntil).toBe(Date.parse(NEXT_YEAR));
  });

  it('takes a new subscription over a lapsed one from the transaction that paid for it', () => {
    const lapsed: PlanRow = { ...row, plan: 'active', source: 'paddle', paddleSubscriptionId: 'sub_old', paddleStatus: 'canceled', paddleCancelsAt: Date.parse('2026-09-01T00:00:00Z'), planUntil: Date.parse('2026-09-01T00:00:00Z') };
    const txn: PaddleTransaction = {
      id: 'txn_2',
      status: 'completed',
      customer_id: 'ctm_1',
      subscription_id: 'sub_new',
      custom_data: null,
      billing_period: { starts_at: T0, ends_at: NEXT_YEAR },
      items: [],
      checkout: null,
    };
    expect(planPatchFor(paddle, event('transaction.completed', txn), lapsed)).toMatchObject({
      plan: 'active',
      planUntil: Date.parse(NEXT_YEAR),
      paddleSubscriptionId: 'sub_new',
      paddleStatus: 'active',
      paddleCancelsAt: null,
    });
  });

  it('activates from a completed transaction when it arrives first, and defers the rest to the subscription', () => {
    const txn: PaddleTransaction = {
      id: 'txn_1',
      status: 'completed',
      customer_id: 'ctm_1',
      subscription_id: 'sub_1',
      custom_data: { user_id: 'u' },
      billing_period: { starts_at: T0, ends_at: NEXT_YEAR },
      items: [{ price: { id: 'pri_storage' }, quantity: 1 }],
      checkout: null,
    };
    expect(planPatchFor(paddle, event('transaction.completed', txn), row)).toEqual({
      plan: 'active',
      source: 'paddle',
      planUntil: Date.parse(NEXT_YEAR),
      paddleSubscriptionId: 'sub_1',
      paddleStatus: 'active',
      paddleCancelsAt: null,
      lapseNotifiedAt: null,
    });
    // Once the subscription is known, a proration's transaction names nothing new.
    const known: PlanRow = { ...row, paddleSubscriptionId: 'sub_1', paddleStatus: 'active' };
    const patch = planPatchFor(paddle, event('transaction.completed', txn), known)!;
    expect(patch.paddleSubscriptionId).toBeUndefined();
    expect(patch.storageGb).toBeUndefined();
    // A one-off charge is not the plan's.
    expect(planPatchFor(paddle, event('transaction.completed', { ...txn, subscription_id: null }), row)).toBeNull();
  });

  /**
   * The subscription event for a checkout happens before its transaction completes. A
   * transaction that stamped the row would have the guard refuse that event as older,
   * and the storage it alone carries would never land.
   */
  it('leaves the event stamp to the subscription events, so the one behind a transaction still applies', () => {
    const txn: PaddleTransaction = {
      id: 'txn_1',
      status: 'completed',
      customer_id: 'ctm_1',
      subscription_id: 'sub_1',
      custom_data: null,
      billing_period: { starts_at: T0, ends_at: NEXT_YEAR },
      items: [{ price: { id: 'pri_storage' }, quantity: 1 }],
      checkout: null,
    };
    expect(planPatchFor(paddle, event('transaction.completed', txn, T1), row)).not.toHaveProperty('paddleEventAt');
    expect(planPatchFor(paddle, event('subscription.created', sub(), T0), row)).toMatchObject({ paddleEventAt: T0 });
  });

  /**
   * A former subscriber who is comped keeps their customer id, so the webhook finds the
   * row; and a person who lapsed and subscribed again has an old subscription whose late
   * news must not take the row back.
   */
  it('leaves a comped account alone, and a live subscription to its own events', () => {
    const comped: PlanRow = { ...row, plan: 'active', source: 'comp', planUntil: null, paddleSubscriptionId: 'sub_old', paddleStatus: 'canceled' };
    expect(planPatchFor(paddle, event('subscription.updated', sub({ id: 'sub_old', status: 'canceled', current_billing_period: null })), comped)).toBeNull();
    expect(planPatchFor(paddle, event('subscription.created', sub({ id: 'sub_new' })), comped)).toBeNull();
    // A comp that has ended is a lapsed account, and a new subscription is its way back.
    const ended: PlanRow = { ...comped, plan: 'inactive', planUntil: Date.parse('2026-10-01T00:00:00Z') };
    expect(planPatchFor(paddle, event('subscription.created', sub({ id: 'sub_new' })), ended)).toMatchObject({ plan: 'active', source: 'paddle', paddleSubscriptionId: 'sub_new' });
    const dated: PlanRow = { ...comped, plan: 'active', planUntil: Date.parse('2026-10-01T00:00:00Z') };
    expect(planPatchFor(paddle, event('subscription.created', sub({ id: 'sub_new' })), dated)).not.toBeNull();

    const live: PlanRow = { ...row, plan: 'active', source: 'paddle', paddleSubscriptionId: 'sub_new', paddleStatus: 'active' };
    expect(planPatchFor(paddle, event('subscription.canceled', sub({ id: 'sub_old', status: 'canceled', current_billing_period: null })), live)).toBeNull();
    const txn: PaddleTransaction = { id: 'txn_old', status: 'completed', customer_id: 'ctm_1', subscription_id: 'sub_old', custom_data: null, billing_period: { starts_at: T0, ends_at: NEXT_YEAR }, items: [], checkout: null };
    expect(planPatchFor(paddle, event('transaction.completed', txn), live)).toBeNull();
    expect(planPatchFor(paddle, event('subscription.updated', sub({ id: 'sub_new' })), live)).not.toBeNull();
  });

  it('ignores what it does not follow', () => {
    expect(planPatchFor(paddle, event('subscription.imported', sub()), row)).toBeNull();
    expect(planPatchFor(paddle, event('customer.updated', sub()), row)).toBeNull();
  });
});

/**
 * A refund in Paddle leaves the subscription renewing; the terms say it does not. These
 * are the rules that keep the terms' word, on the refund alone and on the transaction's
 * lines when a partial refund needs them.
 */
describe('refundEffectOf', () => {
  const paid: PlanRow = { ...row, plan: 'active', source: 'paddle', paddleSubscriptionId: 'sub_1', paddleStatus: 'active', planUntil: Date.parse(NEXT_YEAR) };
  // The transaction's lines as a read of it names them: the plan, and two units of storage.
  const lines = [
    { id: 'txnitm_plan', price_id: 'pri_plan', quantity: 1 },
    { id: 'txnitm_storage', price_id: 'pri_storage', quantity: 2 },
  ];
  function refund(over: Partial<PaddleAdjustment> = {}): PaddleAdjustment {
    return {
      id: 'adj_1',
      action: 'refund',
      type: 'full',
      status: 'approved',
      transaction_id: 'txn_1',
      subscription_id: 'sub_1',
      customer_id: 'ctm_1',
      items: [],
      ...over,
    };
  }

  it('cancels the subscription for a refund of the whole transaction, on either adjustment event', () => {
    expect(refundEffectOf(paddle, event('adjustment.created', refund()), paid)).toBe('cancel');
    expect(refundEffectOf(paddle, event('adjustment.updated', refund()), paid)).toBe('cancel');
    // A chargeback is the card issuer's refund.
    expect(refundEffectOf(paddle, event('adjustment.created', refund({ action: 'chargeback' })), paid)).toBe('cancel');
  });

  it('reads a partial refund by the lines it names, once the transaction has been read', () => {
    const ofPlan = refund({ type: 'partial', items: [{ id: 'adjitm_1', item_id: 'txnitm_plan', type: 'full', amount: null }] });
    expect(refundEffectOf(paddle, event('adjustment.created', ofPlan), paid)).toBe('needs-transaction');
    expect(refundEffectOf(paddle, event('adjustment.created', ofPlan), paid, lines)).toBe('cancel');
    const ofStorage = refund({ type: 'partial', items: [{ id: 'adjitm_1', item_id: 'txnitm_storage', type: 'partial', amount: '600' }] });
    expect(refundEffectOf(paddle, event('adjustment.created', ofStorage), paid, lines)).toBe('remove-storage');
    const ofBoth = refund({ type: 'partial', items: [...ofPlan.items, ...ofStorage.items] });
    expect(refundEffectOf(paddle, event('adjustment.created', ofBoth), paid, lines)).toBe('cancel');
    // A line the transaction does not name cannot be told from the plan's, and is read as it.
    const ofUnknown = refund({ type: 'partial', items: [{ id: 'adjitm_1', item_id: 'txnitm_tax', type: 'tax', amount: null }] });
    expect(refundEffectOf(paddle, event('adjustment.created', ofUnknown), paid, lines)).toBe('cancel');
    expect(refundEffectOf(paddle, event('adjustment.created', refund({ type: 'partial' })), paid, lines)).toBe('cancel');
  });

  it('does nothing for a refund that is not of this subscription, not approved, or not a refund', () => {
    // A one-off charge.
    expect(refundEffectOf(paddle, event('adjustment.created', refund({ subscription_id: null })), paid)).toBeNull();
    // A former subscription's late refund.
    expect(refundEffectOf(paddle, event('adjustment.created', refund({ subscription_id: 'sub_old' })), paid)).toBeNull();
    // A row that never subscribed.
    expect(refundEffectOf(paddle, event('adjustment.created', refund()), row)).toBeNull();
    // Awaiting Paddle's approval, or refused it.
    expect(refundEffectOf(paddle, event('adjustment.created', refund({ status: 'pending_approval' })), paid)).toBeNull();
    expect(refundEffectOf(paddle, event('adjustment.updated', refund({ status: 'rejected' })), paid)).toBeNull();
    // A credit stays on the balance; a reversal undoes nothing here.
    expect(refundEffectOf(paddle, event('adjustment.created', refund({ action: 'credit' })), paid)).toBeNull();
    expect(refundEffectOf(paddle, event('adjustment.created', refund({ action: 'chargeback_reverse' })), paid)).toBeNull();
    // A comped account is not Paddle's to move.
    expect(refundEffectOf(paddle, event('adjustment.created', refund()), { ...paid, source: 'comp', planUntil: null })).toBeNull();
    expect(refundEffectOf(paddle, event('subscription.updated', sub()), paid)).toBeNull();
  });

  /**
   * The same refund delivered again (or `adjustment.updated` after a `created` that was
   * already approved) finds the row as the first delivery left it, and does nothing.
   */
  it('finds nothing to do once the first delivery has cancelled the subscription', () => {
    const first = event('adjustment.created', refund(), T1);
    expect(refundEffectOf(paddle, first, paid)).toBe('cancel');
    const after: PlanRow = { ...paid, ...refundPatchFor('cancel', first) } as PlanRow;
    expect(refundEffectOf(paddle, first, after)).toBeNull();
    expect(refundEffectOf(paddle, event('adjustment.updated', refund(), NEXT_YEAR), after)).toBeNull();
    // And the cancel the first delivery caused keeps the refund's date, not the year's end.
    const canceled = sub({ status: 'canceled', current_billing_period: null, canceled_at: T1 });
    expect(planPatchFor(paddle, event('subscription.canceled', canceled, NEXT_YEAR), after)?.planUntil).toBe(Date.parse(T1));
  });

  /**
   * The cancel went through at Paddle but its answer was lost, so the first delivery
   * wrote nothing, and `subscription.canceled` left the year's end on the row. The
   * redelivery still has the period to end, and only an add-on refund has nothing left
   * to change on a subscription that is already canceled.
   */
  it('still ends the period on redelivery when the cancel landed and the refund was never written', () => {
    const first = event('adjustment.created', refund(), T1);
    const canceled = event('subscription.canceled', sub({ status: 'canceled', current_billing_period: null, canceled_at: NEXT_YEAR }), NEXT_YEAR);
    const afterCanceled = { ...paid, ...planPatchFor(paddle, canceled, paid) } as PlanRow;
    expect(afterCanceled.planUntil).toBe(paid.planUntil);
    expect(refundEffectOf(paddle, first, afterCanceled)).toBe('cancel');
    const ofStorage = refund({ type: 'partial', items: [{ id: 'adjitm_1', item_id: 'txnitm_storage', type: 'partial', amount: '600' }] });
    expect(refundEffectOf(paddle, event('adjustment.created', ofStorage, T1), afterCanceled, lines)).toBeNull();
  });

  /**
   * `planPatchFor` on a canceled snapshot keeps `planUntil` as the last paid period,
   * which is right for a cancel at the period's end. The refund's patch is what ends
   * it now. If that cancel lands first (the race the webhook used to lose), the
   * refund must still overwrite the date without needing a newer stamp.
   */
  it('still ends the paid period when subscription.canceled lands before the refund patch', () => {
    const refundAt = event('adjustment.created', refund(), T1);
    const canceledAt = event(
      'subscription.canceled',
      sub({ status: 'canceled', current_billing_period: null, canceled_at: NEXT_YEAR }),
      NEXT_YEAR,
    );
    const afterCanceled = { ...paid, ...planPatchFor(paddle, canceledAt, paid) } as PlanRow;
    expect(afterCanceled.planUntil).toBe(paid.planUntil);
    expect(afterCanceled.paddleEventAt).toBe(NEXT_YEAR);
    const refunded = refundPatchFor('cancel', refundAt);
    // The write keeps the later stamp (`advanceStamp`, run on real rows in migrations.test.ts).
    const afterRefund = { ...afterCanceled, ...refunded, paddleEventAt: afterCanceled.paddleEventAt };
    expect(afterRefund.planUntil).toBe(Date.parse(T1));
    expect(afterRefund.paddleStatus).toBe('canceled');
    expect(planPatchFor(paddle, canceledAt, afterRefund)?.planUntil).toBe(Date.parse(T1));
  });

  it('writes the row as the refund leaves the subscription', () => {
    expect(refundPatchFor('cancel', event('adjustment.created', refund(), T1))).toEqual({
      plan: 'active',
      source: 'paddle',
      planUntil: Date.parse(T1),
      paddleStatus: 'canceled',
      paddleCancelsAt: null,
      paddleEventAt: T1,
    });
    expect(refundPatchFor('remove-storage', event('adjustment.created', refund(), T1))).toEqual({ storageGb: 10, paddleEventAt: T1 });
  });

  it('is among the events the destination is asked for', () => {
    expect(HANDLED_EVENTS).toContain('adjustment.created');
    expect(HANDLED_EVENTS).toContain('adjustment.updated');
  });
});
