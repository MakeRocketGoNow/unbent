import { describe, expect, it } from 'vitest';
import { BASE_STORAGE_GB, FREE_NOTES, FREE_STORAGE_GB, GB, TRIAL_DAYS } from '@unbent/shared';
import { RENEWAL_GRACE_MS, accountPlanOf, accountStateOf, lapsed, planStateOf, planUpdateSql, storageGbOf, trialEnd, type PlanRow } from './plan.js';

const NOW = Date.UTC(2026, 9, 10, 12);
const DAY = 24 * 60 * 60 * 1000;

function row(over: Partial<PlanRow> = {}): PlanRow {
  return {
    userId: 'u',
    plan: 'trial',
    planUntil: trialEnd(NOW),
    storageGb: BASE_STORAGE_GB,
    source: null,
    customerId: null,
    subscriptionId: null,
    subscriptionStatus: null,
    cancelsAt: null,
    eventAt: null,
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

  it('keeps a subscription active to the end of what it paid for, whatever Stripe says since', () => {
    const paid = row({ plan: 'active', source: 'stripe', subscriptionStatus: 'canceled', planUntil: NOW + 30 * DAY });
    expect(planStateOf(paid, NOW)).toBe('active');
    expect(planStateOf(paid, NOW + 30 * DAY)).toBe('inactive');
  });

  /**
   * The period's end is the instant Stripe bills the renewal, and the webhook with the
   * next period lands after. A subscriber in good standing keeps editing through that
   * gap; one cancelling, or whose renewal failed, does not.
   */
  it('keeps a renewing subscription active past its end for the grace, and nothing else', () => {
    const end = NOW + 30 * DAY;
    const renewing = row({ plan: 'active', source: 'stripe', subscriptionId: 'sub', subscriptionStatus: 'active', planUntil: end });
    expect(planStateOf(renewing, end)).toBe('active');
    expect(planStateOf(renewing, end + RENEWAL_GRACE_MS - 1)).toBe('active');
    expect(planStateOf(renewing, end + RENEWAL_GRACE_MS)).toBe('inactive');
    expect(accountPlanOf(renewing, NOW)).toMatchObject({ until: end, readOnlyAt: end + RENEWAL_GRACE_MS });
    expect(planStateOf({ ...renewing, cancelsAt: end }, end)).toBe('inactive');
    expect(planStateOf({ ...renewing, subscriptionStatus: 'past_due' }, end)).toBe('inactive');
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
    const scheduled = row({ plan: 'active', source: 'stripe', subscriptionStatus: 'active', planUntil: NOW + 20 * DAY, cancelsAt: NOW + 20 * DAY });
    expect(accountPlanOf(scheduled, NOW).subscription).toEqual({ status: 'active', cancelsAt: NOW + 20 * DAY, pastDue: false });
    const effected = row({ plan: 'active', source: 'stripe', subscriptionStatus: 'canceled', planUntil: NOW + 20 * DAY });
    expect(accountPlanOf(effected, NOW).subscription?.cancelsAt).toBe(NOW + 20 * DAY);
    expect(accountPlanOf(effected, NOW + 21 * DAY).subscription?.cancelsAt).toBeNull();
    expect(accountPlanOf(effected, NOW + 21 * DAY).state).toBe('inactive');
  });

  it('flags a renewal Stripe could not collect', () => {
    const due = row({ plan: 'active', source: 'stripe', subscriptionStatus: 'past_due', planUntil: NOW + 5 * DAY });
    expect(accountPlanOf(due, NOW).subscription?.pastDue).toBe(true);
  });
});

describe('the free plan', () => {
  const ended = NOW + (TRIAL_DAYS + 1) * DAY;
  const small = { notes: FREE_NOTES, attachmentBytes: FREE_STORAGE_GB * GB };
  const big = { notes: 1000, attachmentBytes: 0 };

  it('reads an ended trial, a lapsed subscription and an ended comp by what the account holds', () => {
    const lapsedRows = [
      row(),
      row({ plan: 'active', source: 'stripe', subscriptionStatus: 'canceled', planUntil: NOW + DAY }),
      row({ plan: 'active', source: 'comp', planUntil: NOW + DAY }),
      row({ plan: 'inactive', source: 'comp', planUntil: NOW }),
    ];
    for (const r of lapsedRows) {
      expect(lapsed(r, ended)).toBe(true);
      expect(accountStateOf(r, ended, small)).toBe('free');
      expect(accountStateOf(r, ended, big)).toBe('inactive');
      // Nothing to read it against is the row's own word.
      expect(accountStateOf(r, ended)).toBe('inactive');
    }
    // A plan that holds is what it is, whatever the account holds.
    expect(accountStateOf(row(), NOW, big)).toBe('trial');
    expect(accountStateOf(row({ plan: 'active', source: 'comp', planUntil: null }), NOW, big)).toBe('active');
  });

  it('gives a free account no instant to lock at, and the free plan’s storage while no plan holds', () => {
    const free = accountPlanOf(row(), ended, small);
    expect(free).toMatchObject({ state: 'free', readOnlyAt: null, storageGb: FREE_STORAGE_GB, until: trialEnd(NOW) });
    expect(accountPlanOf(row(), ended, big)).toMatchObject({ state: 'inactive', readOnlyAt: trialEnd(NOW), storageGb: FREE_STORAGE_GB });
    expect(accountPlanOf(row(), NOW, big)).toMatchObject({ state: 'trial', storageGb: BASE_STORAGE_GB });
    expect(storageGbOf(row({ plan: 'active', source: 'comp', planUntil: null, storageGb: 35 }), NOW)).toBe(35);
  });
});

describe('planUpdateSql', () => {
  const patch = {
    plan: 'active' as const,
    source: 'stripe' as const,
    planUntil: NOW,
    subscriptionStatus: 'canceled',
    cancelsAt: null,
    eventAt: '2026-10-10T12:00:05.000Z',
  };

  it('keeps an older event from writing over a newer one', () => {
    const { sql, binds } = planUpdateSql('u1', { plan: 'active' }, NOW, { notBefore: '2026-10-11T00:00:00.000Z' });
    expect(sql).toContain('WHERE user_id = ?1 AND (billing_event_at IS NULL OR billing_event_at <= ?4)');
    expect(binds).toEqual(['u1', NOW, 'active', '2026-10-11T00:00:00.000Z']);
  });

  /**
   * A refund cancel must still end the paid period when `customer.subscription.deleted`
   * landed first and stamped the row later than the refund. The stamp only moves forward,
   * and a different subscription on the row is left alone.
   */
  it('ends a refunded subscription even when a newer stamp is already on the row', () => {
    const { sql, binds } = planUpdateSql('u1', patch, NOW, { onlyIfSubscription: 'sub_1', advanceStamp: true });
    expect(sql).toContain(
      'billing_event_at = CASE WHEN billing_event_at IS NULL OR billing_event_at <= ?8 THEN ?8 ELSE billing_event_at END',
    );
    expect(sql).toContain('WHERE user_id = ?1 AND billing_subscription_id = ?9');
    expect(sql).not.toMatch(/billing_event_at <= \?9/);
    expect(binds).toEqual(['u1', NOW, 'active', 'stripe', NOW, 'canceled', null, '2026-10-10T12:00:05.000Z', 'sub_1']);
  });
});
