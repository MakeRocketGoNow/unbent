import { describe, expect, it, vi } from 'vitest';
import { GB } from '@unbent/shared';
import { PlanRefused, refuseIfPastFree } from './free-plan.js';
import type { PlanRow } from './plan.js';

/**
 * The check a file route makes before it fetches or streams anything: an account past
 * the free plan is refused there, one read of its store's counts, and nobody else is
 * asked anything.
 */
describe('refuseIfPastFree', () => {
  const stripe = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 's', STRIPE_PLAN_PRICE_ID: 'p', STRIPE_STORAGE_PRICE_ID: 'q' };
  const ended = { plan: 'inactive', planUntil: 1, storageGb: 10, source: null, subscriptionStatus: null, cancelsAt: null } as unknown as PlanRow;
  const active = { plan: 'active', planUntil: null, storageGb: 10, source: 'comp', subscriptionStatus: null, cancelsAt: null } as unknown as PlanRow;
  const store = (notes: number, attachmentBytes = 0) => ({
    usage: vi.fn(async () => ({ notes, attachmentBytes, databaseSize: 1, lastWriteAt: null, wiped: false })),
  });

  it('refuses an account past the free plan, and lets one that fits go on', async () => {
    await expect(refuseIfPastFree(stripe, store(101), ended)).rejects.toBeInstanceOf(PlanRefused);
    await expect(refuseIfPastFree(stripe, store(5, 2 * GB), ended)).rejects.toMatchObject({ code: 'PLAN_INACTIVE' });
    // One that fits is handed the files' sum it read, for the quota's check after it.
    await expect(refuseIfPastFree(stripe, store(100, GB), ended)).resolves.toBe(GB);
  });

  it('reads nothing for an account a plan holds, or where billing is off', async () => {
    const held = store(1000);
    await expect(refuseIfPastFree(stripe, held, active)).resolves.toBeUndefined();
    await expect(refuseIfPastFree({}, held, ended)).resolves.toBeUndefined();
    expect(held.usage).not.toHaveBeenCalled();
  });
});
