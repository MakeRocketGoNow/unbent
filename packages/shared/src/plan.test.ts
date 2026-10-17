import { describe, expect, it } from 'vitest';
import { PLAN_PRICE_USD, STORAGE_ADDON_PRICE_USD } from './plan.js';

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
    'and nothing sends it. Send the mail, wait the 30 days, change Paddle’s catalog, then change the constant and ' +
    'this number together. See "Changing the price" in docs/billing.md.';

  it('stay what the subscribers were told, until they are told otherwise', () => {
    expect(PLAN_PRICE_USD, promise).toBe(60);
    expect(STORAGE_ADDON_PRICE_USD, promise).toBe(12);
  });
});
