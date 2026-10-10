import { describe, expect, it } from 'vitest';
import { planPatchFor, storageGbOf, type PaddleEvent } from './billing-events.js';
import type { PaddleConfig, PaddleSubscription, PaddleTransaction } from './paddle.js';
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

const event = (event_type: string, data: PaddleSubscription | PaddleTransaction, occurred_at = T0): PaddleEvent => ({
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

  it('does not clear the lapse notice when the period it reports is already over', () => {
    const over = sub({ status: 'past_due', current_billing_period: { starts_at: '2025-10-10T12:00:00Z', ends_at: '2026-10-09T12:00:00Z' } });
    const patch = planPatchFor(paddle, event('subscription.past_due', over, T0), row)!;
    expect(patch.paddleStatus).toBe('past_due');
    expect('lapseNotifiedAt' in patch).toBe(false);
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
      paddleEventAt: T0,
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

  it('ignores what it does not follow', () => {
    expect(planPatchFor(paddle, event('subscription.imported', sub()), row)).toBeNull();
    expect(planPatchFor(paddle, event('customer.updated', sub()), row)).toBeNull();
  });
});
