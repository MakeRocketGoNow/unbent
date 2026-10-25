import { describe, expect, it } from 'vitest';
import {
  FREE_NOTES,
  FREE_STORAGE_GB,
  GB,
  PLAN_INACTIVE_MESSAGE,
  PLAN_PRICE_USD,
  STORAGE_ADDON_PRICE_USD,
  fitsFree,
  freeNotesFullMessage,
  planInactiveMessage,
} from './plan.js';

/*
 * The prices are pinned on purpose, and this test is the reminder, not a check on
 * arithmetic. The terms promise every subscriber an email at least 30 days before the
 * renewal a price change applies to ("Plans and payment" in the web app's
 * `legal/documents.ts`), and nothing sends that mail. The comment on the constants says
 * so too, but a comment is skipped and a red test is not: a changed price fails here, on
 * the machine of whoever changed it, with the promise in the message.
 *
 * When the mail has gone out and the 30 days have passed, update the numbers below in the
 * same commit as the constants, and the test is green again. The order of the whole
 * change is in docs/billing.md under "Changing the price".
 */
describe('the plan’s prices', () => {
  const promise =
    'The terms promise subscribers an email at least 30 days before a price change takes effect at their renewal, ' +
    'and nothing sends it. Send the mail, wait the 30 days, change Stripe’s catalog, then change the constant and ' +
    'this number together. See "Changing the price" in docs/billing.md.';

  it('stay what the subscribers were told, until they are told otherwise', () => {
    expect(PLAN_PRICE_USD, promise).toBe(60);
    expect(STORAGE_ADDON_PRICE_USD, promise).toBe(12);
  });
});

describe('the free plan', () => {
  it('fits an account at its numbers and not past them, counting notes and files apart', () => {
    expect(fitsFree({ notes: FREE_NOTES, attachmentBytes: FREE_STORAGE_GB * GB })).toBe(true);
    expect(fitsFree({ notes: FREE_NOTES + 1, attachmentBytes: 0 })).toBe(false);
    expect(fitsFree({ notes: 0, attachmentBytes: FREE_STORAGE_GB * GB + 1 })).toBe(false);
  });

  it('names only what is over in the read-only sentence', () => {
    expect(planInactiveMessage({ notes: 1000, attachmentBytes: 0 })).toContain("1,000 notes, more than the free plan's 100");
    expect(planInactiveMessage({ notes: 1000, attachmentBytes: 0 })).not.toContain('of files');
    expect(planInactiveMessage({ notes: 5, attachmentBytes: 3 * GB })).toContain('3.0 GB of files, more than the free plan');
    expect(planInactiveMessage()).toBe(PLAN_INACTIVE_MESSAGE);
  });

  it('says how much room a batch had when it would pass the count', () => {
    expect(freeNotesFullMessage(100)).toContain('this account holds 100.');
    expect(freeNotesFullMessage(97, 5)).toContain('this account holds 97, with room for 3 more.');
  });
});
