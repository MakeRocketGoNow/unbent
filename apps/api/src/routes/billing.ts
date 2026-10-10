import { Hono } from 'hono';
import { accountPlanOf, planFor } from '../lib/plan.js';
import { billingOn } from '../lib/paddle.js';
import { requireAuth } from '../lib/session.js';
import type { AppEnv } from '../types.js';

/**
 * The plan (MAK-108): what the signed-in account is on, and, further down this file as
 * the work lands, the checkout, the portal and Paddle's webhook.
 *
 * Every route here answers 404 where billing is off, the way the account-deletion
 * endpoint does where there is no mail: an instance with nothing to sell has no plan to
 * report, and `/api/config` carries no `billing`, so no client asks.
 */
export const billing = new Hono<AppEnv>()
  /**
   * The account's plan, for the Plan page, the trial banner and the editor's read-only
   * state. One D1 read, usually; the first read after a sign-up whose hook failed makes
   * the row (`planFor`). Read on open and after anything that changes it — a checkout, a
   * portal visit — rather than on every write: the 402 a lapsed write gets is the guard,
   * and this is what lets the page say so before anyone types.
   */
  .get('/me/plan', requireAuth, async (c) => {
    if (!billingOn(c.env)) return c.json({ error: 'This instance has no plan to report.' }, 404);
    const row = await planFor(c.env.DB, c.get('userId')!);
    return c.json(accountPlanOf(row, Date.now()));
  });
