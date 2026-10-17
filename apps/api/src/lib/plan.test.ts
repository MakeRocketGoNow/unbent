import { describe, expect, it } from 'vitest';
import { BASE_STORAGE_GB, TRIAL_DAYS } from '@unbent/shared';
import { RENEWAL_GRACE_MS, accountPlanOf, planStateOf, planUpdateSql, trialEnd, type PlanRow } from './plan.js';
import { billingOf, paddleOf } from './paddle.js';

const NOW = Date.UTC(2026, 9, 10, 12);
const DAY = 24 * 60 * 60 * 1000;

function row(over: Partial<PlanRow> = {}): PlanRow {
  return {
    userId: 'u',
    plan: 'trial',
    planUntil: trialEnd(NOW),
    storageGb: BASE_STORAGE_GB,
    source: null,
    paddleCustomerId: null,
    paddleSubscriptionId: null,
    paddleStatus: null,
    paddleCancelsAt: null,
    paddleEventAt: null,
    lapseNotifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe('planStateOf', () => {
  it('is a trial from sign-up until the fortnight is up, then inactive', () => {
    expect(trialEnd(NOW) - NOW).toBe(TRIAL_DAYS * DAY);
    expect(planStateOf(row(), NOW)).toBe('trial');
    expect(planStateOf(row(), trialEnd(NOW) - 1)).toBe('trial');
    expect(planStateOf(row(), trialEnd(NOW))).toBe('inactive');
  });

  it('reads a missing row as a trial, since the first read makes one', () => {
    expect(planStateOf(null, NOW)).toBe('trial');
  });

  it('keeps a subscription active to the end of what it paid for, whatever Paddle says since', () => {
    const paid = row({ plan: 'active', source: 'paddle', paddleStatus: 'canceled', planUntil: NOW + 30 * DAY });
    expect(planStateOf(paid, NOW)).toBe('active');
    expect(planStateOf(paid, NOW + 30 * DAY)).toBe('inactive');
  });

  /**
   * The period's end is the instant Paddle bills the renewal, and the webhook with the
   * next period lands after. A subscriber in good standing keeps editing through that
   * gap; one cancelling, or whose renewal failed, does not.
   */
  it('keeps a renewing subscription active past its end for the grace, and nothing else', () => {
    const end = NOW + 30 * DAY;
    const renewing = row({ plan: 'active', source: 'paddle', paddleSubscriptionId: 'sub', paddleStatus: 'active', planUntil: end });
    expect(planStateOf(renewing, end)).toBe('active');
    expect(planStateOf(renewing, end + RENEWAL_GRACE_MS - 1)).toBe('active');
    expect(planStateOf(renewing, end + RENEWAL_GRACE_MS)).toBe('inactive');
    expect(accountPlanOf(renewing, NOW)).toMatchObject({ until: end, readOnlyAt: end + RENEWAL_GRACE_MS });
    expect(planStateOf({ ...renewing, paddleCancelsAt: end }, end)).toBe('inactive');
    expect(planStateOf({ ...renewing, paddleStatus: 'past_due' }, end)).toBe('inactive');
    expect(accountPlanOf(row(), NOW)).toMatchObject({ until: trialEnd(NOW), readOnlyAt: trialEnd(NOW) });
  });

  it('gives a comp no end unless one was set', () => {
    expect(planStateOf(row({ plan: 'active', source: 'comp', planUntil: null }), NOW + 3650 * DAY)).toBe('active');
    expect(planStateOf(row({ plan: 'active', source: 'comp', planUntil: NOW + DAY }), NOW + 2 * DAY)).toBe('inactive');
  });

  it('takes the row at its word when it says inactive, whatever the date', () => {
    expect(planStateOf(row({ plan: 'inactive', planUntil: NOW + DAY }), NOW)).toBe('inactive');
  });
});

describe('accountPlanOf', () => {
  it('says nothing of a subscription for a trial or a comp', () => {
    expect(accountPlanOf(row(), NOW).subscription).toBeNull();
    expect(accountPlanOf(row({ plan: 'active', source: 'comp', planUntil: null }), NOW).subscription).toBeNull();
  });

  it('names a cancellation still ahead, scheduled or taken effect, and not one that has passed', () => {
    const scheduled = row({ plan: 'active', source: 'paddle', paddleStatus: 'active', planUntil: NOW + 20 * DAY, paddleCancelsAt: NOW + 20 * DAY });
    expect(accountPlanOf(scheduled, NOW).subscription).toEqual({ status: 'active', cancelsAt: NOW + 20 * DAY, pastDue: false });
    const effected = row({ plan: 'active', source: 'paddle', paddleStatus: 'canceled', planUntil: NOW + 20 * DAY });
    expect(accountPlanOf(effected, NOW).subscription?.cancelsAt).toBe(NOW + 20 * DAY);
    expect(accountPlanOf(effected, NOW + 21 * DAY).subscription?.cancelsAt).toBeNull();
    expect(accountPlanOf(effected, NOW + 21 * DAY).state).toBe('inactive');
  });

  it('flags a renewal Paddle could not collect', () => {
    const due = row({ plan: 'active', source: 'paddle', paddleStatus: 'past_due', planUntil: NOW + 5 * DAY });
    expect(accountPlanOf(due, NOW).subscription?.pastDue).toBe(true);
  });
});

describe('planUpdateSql', () => {
  const patch = {
    plan: 'active' as const,
    source: 'paddle' as const,
    planUntil: NOW,
    paddleStatus: 'canceled',
    paddleCancelsAt: null,
    paddleEventAt: '2026-10-10T12:00:05.000Z',
  };

  it('keeps an older event from writing over a newer one', () => {
    const { sql, binds } = planUpdateSql('u1', { plan: 'active' }, NOW, { notBefore: '2026-10-11T00:00:00.000Z' });
    expect(sql).toContain('WHERE user_id = ?1 AND (paddle_event_at IS NULL OR paddle_event_at <= ?4)');
    expect(binds).toEqual(['u1', NOW, 'active', '2026-10-11T00:00:00.000Z']);
  });

  /**
   * A refund cancel must still end the paid period when `subscription.canceled` landed
   * first and stamped the row later than the adjustment. The stamp only moves forward,
   * and a different subscription on the row is left alone.
   */
  it('ends a refunded subscription even when a newer stamp is already on the row', () => {
    const { sql, binds } = planUpdateSql('u1', patch, NOW, { onlyIfSubscription: 'sub_1', advanceStamp: true });
    expect(sql).toContain(
      'paddle_event_at = CASE WHEN paddle_event_at IS NULL OR paddle_event_at <= ?8 THEN ?8 ELSE paddle_event_at END',
    );
    expect(sql).toContain('WHERE user_id = ?1 AND paddle_subscription_id = ?9');
    expect(sql).not.toMatch(/paddle_event_at <= \?9/);
    expect(binds).toEqual(['u1', NOW, 'active', 'paddle', NOW, 'canceled', null, '2026-10-10T12:00:05.000Z', 'sub_1']);
  });
});

describe('paddleOf', () => {
  const all = {
    PADDLE_API_KEY: 'pdl_sdbx_apikey_x',
    PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_x',
    PADDLE_CLIENT_TOKEN: 'test_x',
    PADDLE_PLAN_PRICE_ID: 'pri_plan',
    PADDLE_STORAGE_PRICE_ID: 'pri_storage',
  };

  it('is off with any setting missing, and on with all five', () => {
    expect(paddleOf({})).toBeUndefined();
    for (const key of Object.keys(all) as Array<keyof typeof all>) {
      expect(paddleOf({ ...all, [key]: ' ' }), key).toBeUndefined();
    }
    expect(paddleOf(all)?.environment).toBe('sandbox');
    expect(paddleOf(all)?.apiUrl).toBe('https://sandbox-api.paddle.com');
  });

  it('reads the environment off the key, and lets a stand-in take the calls', () => {
    const live = paddleOf({ ...all, PADDLE_API_KEY: 'pdl_live_apikey_x' });
    expect(live?.environment).toBe('live');
    expect(live?.apiUrl).toBe('https://api.paddle.com');
    expect(paddleOf({ ...all, PADDLE_API_URL: 'http://localhost:9999/' })?.apiUrl).toBe('http://localhost:9999');
  });

  it('tells the page only what the page needs', () => {
    expect(billingOf(all)).toEqual({ environment: 'sandbox', clientToken: 'test_x' });
    expect(billingOf({})).toBeUndefined();
  });
});
