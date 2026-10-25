import { describe, expect, it } from 'vitest';
import { BASE_STORAGE_GB } from '@unbent/shared';
import { limitsFor, trialSentences } from './llm-usage.js';
import type { PlanRow } from './plan.js';

/**
 * Which Auto-fill numbers an account gets: the ordinary ones while a plan holds, the
 * trial's on a trial and on the free plan, and the free plan's pool only on the free
 * plan (decided 2026-10-24), so a trial's presses never come out of it.
 */

const NOW = Date.UTC(2026, 9, 25, 12);
const DAY = 86_400_000;
const stripe = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 's', STRIPE_PLAN_PRICE_ID: 'p', STRIPE_STORAGE_PRICE_ID: 'q' };
const caps = {
  AUTOFILL_DAILY_CAP: '500',
  AUTOFILL_TRIAL_DAILY_CAP: '50',
  AUTOFILL_YEARLY_CENTS: '5000',
  AUTOFILL_TRIAL_YEARLY_CENTS: '300',
  AUTOFILL_FREE_PRESSES: '100',
};

function row(over: Partial<PlanRow> = {}): PlanRow {
  return {
    userId: 'u',
    plan: 'trial',
    planUntil: NOW + 7 * DAY,
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

describe('the numbers a press is held to', () => {
  it('gives the free plan the trial’s day and year and its own pool, and nobody else the pool', () => {
    const env = { ...stripe, ...caps };
    expect(limitsFor(env, row({ planUntil: NOW - DAY }), NOW)).toEqual({ cap: 50, yearlyCents: 300, freePresses: 100 });
    expect(limitsFor(env, row(), NOW)).toEqual({ cap: 50, yearlyCents: 300, freePresses: null });
    expect(limitsFor(env, row({ plan: 'active', source: 'comp', planUntil: null }), NOW)).toEqual({ cap: 500, yearlyCents: 5000, freePresses: null });
    // A free account is told the day's and the year's refusals in the ordinary words:
    // "during the trial" would be false of it, and so would a subscription's "more" for a
    // day that ends at midnight.
    expect(trialSentences(env, row({ planUntil: NOW - DAY }), NOW)).toEqual({ day: false, year: false });
  });

  it('has no pool when the instance sets none, and none at all where billing is off', () => {
    const { AUTOFILL_FREE_PRESSES: _, ...unset } = caps;
    expect(limitsFor({ ...stripe, ...unset }, row({ planUntil: NOW - DAY }), NOW).freePresses).toBeNull();
    expect(limitsFor(caps, undefined, NOW)).toEqual({ cap: 500, yearlyCents: 5000, freePresses: null });
  });
});
