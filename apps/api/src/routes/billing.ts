import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { BASE_STORAGE_GB, GB, MAX_STORAGE_UNITS, STORAGE_ADDON_GB, storageQuotaBytes, storeLimitBytes } from '@unbent/shared';
import { ADJUSTMENT_EVENTS, planPatchFor, refundEffectOf, refundPatchFor, type PaddleEvent } from '../lib/billing-events.js';
import { accountPlanOf, planFor, planRowByCustomer, planStateOf, updatePlan, updatePlanStatement } from '../lib/plan.js';
import {
  PaddleError,
  billingOn,
  createCheckoutTransaction,
  createPortalSession,
  ensureSubscriptionCanceled,
  findOrCreateCustomer,
  getSubscription,
  getTransaction,
  newestSubscription,
  paddleOf,
  removeSubscriptionStorage,
  setSubscriptionStorage,
  verifyWebhookSignature,
  webhookSourceOf,
  type PaddleAdjustment,
} from '../lib/paddle.js';
import { noStoreLimit } from '../lib/notes-repo.js';
import { roomOf } from '../lib/quota.js';
import { reposFor } from '../lib/repos.js';
import { requireAuth } from '../lib/session.js';
import type { AppEnv } from '../types.js';

/**
 * The plan (MAK-108): what the signed-in account is on, the checkout and the portal that
 * change it, and Paddle's webhook, which is how the change comes back.
 *
 * Every route here answers 404 where billing is off, the way the account-deletion
 * endpoint does where there is no mail: an instance with nothing to sell has no plan to
 * report, and `/api/config` carries no `billing`, so no client asks.
 *
 * A refusal from Paddle is answered 502 with Paddle's own words, not 500: the request
 * was sound and the fault is on the other side of a network, which is the one thing the
 * person can do something about: try again. Logged with the account, since a 502 the
 * page shows says nothing about which call it was.
 */

const storageBody = z.object({ storage: z.number().int().min(0).max(MAX_STORAGE_UNITS) });

/** The webhook's envelope, as much of it as the route reads before the rules do. */
const eventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string().min(1),
  data: z.object({ customer_id: z.string().nullable() }).passthrough(),
});

/**
 * An event's time as the row keeps and compares it: parsed and written back as
 * milliseconds in ISO 8601, so Paddle's microsecond stamps and this code's millisecond
 * ones order by value rather than by whichever is the longer string.
 */
function eventStamp(rfc3339: string): string {
  const t = Date.parse(rfc3339);
  return Number.isFinite(t) ? new Date(t).toISOString() : rfc3339;
}

function paddleRefused(err: unknown, what: string, userId: string): Response {
  if (!(err instanceof PaddleError)) throw err;
  console.error(`[billing] ${what} for user=${userId} refused:`, err.message);
  return Response.json({ error: `Paddle could not ${what} right now. Try again shortly.` }, { status: 502 });
}

export const billing = new Hono<AppEnv>()
  /**
   * The account's plan, for the Plan page, the trial banner and the editor's read-only
   * state. One D1 read, usually; the first read after a sign-up whose hook failed makes
   * the row (`planFor`). Read on open and after anything that changes it (a checkout, a
   * portal visit) rather than on every write: the 402 a lapsed write gets is the guard,
   * and this is what lets the page say so before anyone types.
   *
   * What the account holds comes from its store, which is a call to the account's
   * object: asked for with `?usage=1`, which only the Plan page passes, so the banner
   * and the editor, which read this on every open and every focus in every tab,
   * cost a D1 row and nothing more. Left out rather than failed when the store cannot
   * say (reset by a deploy, or being loaded), since the plan is still the plan.
   *
   * Both figures come from the one call the sweep makes (`usage`): the bytes of the
   * account's files, which the quota bounds, and the size of the store itself, which
   * the store limit bounds (MAK-234). The page shows the two side by side, since a
   * note write refused for the store's size sends people here, and a page that showed
   * files alone then said "2 GB of 10 GB used" under a message that their notes were
   * full.
   */
  .get('/me/plan', requireAuth, async (c) => {
    if (!billingOn(c.env)) return c.json({ error: 'This instance has no plan to report.' }, 404);
    const userId = c.get('userId')!;
    const row = await planFor(c.env.DB, userId);
    let held: { usedBytes: number; storeBytes: number } | undefined;
    if (c.req.query('usage') === '1') {
      try {
        const usage = await reposFor(c.env, userId, noStoreLimit).attachments.usage();
        held = { usedBytes: usage.attachmentBytes, storeBytes: usage.databaseSize };
      } catch (err) {
        console.warn(`[billing] storage used for user=${userId} unavailable:`, (err as Error).message);
      }
    }
    return c.json({ ...accountPlanOf(row, Date.now()), ...held });
  })

  /**
   * A checkout for the page to open: the plan, with `storage` add-ons beside it. The
   * answer is the transaction's id, which Paddle.js opens as an overlay with the
   * client-side token from `/api/config`, and the account's Paddle customer id, which
   * Paddle.js is initialised with for Retain (`pwCustomer`); the page never learns a price id, and the
   * customer is ours before the checkout opens, so the plan row holds Paddle's id for
   * the account by the time the first event names it.
   *
   * Only for an account with no subscription: one that has one changes it through the
   * portal or `POST /billing/storage`, and a second checkout would be a second
   * subscription for one account, which the row cannot hold. A lapsed subscription
   * (`canceled`, its period over) is the one case a new checkout is right for, since
   * Paddle does not revive a canceled subscription.
   */
  .post('/billing/checkout', requireAuth, zValidator('json', storageBody), async (c) => {
    const paddle = paddleOf(c.env);
    if (!paddle) return c.json({ error: 'This instance has no plan to sell.' }, 404);
    const userId = c.get('userId')!;
    const now = Date.now();
    const row = await planFor(c.env.DB, userId, now);
    const live = row.paddleSubscriptionId && !(row.paddleStatus === 'canceled' && planStateOf(row, now) === 'inactive');
    if (live) return c.json({ error: 'This account already has a subscription. Manage it from the portal.' }, 409);
    // The page offers a running comp no checkout; the route refuses one too, since the
    // webhook would then ignore the subscription's events (`planPatchFor`) and the
    // person would be charged for a plan the row never took. A comp that has ended is a
    // lapsed account, and subscribes as one.
    if (row.source === 'comp' && planStateOf(row, now) !== 'inactive') {
      return c.json({ error: 'This account is complimentary; there is nothing to pay for.' }, 409);
    }
    try {
      const customerId = row.paddleCustomerId ?? (await findOrCreateCustomer(paddle, c.get('user')!.email, userId)).id;
      if (customerId !== row.paddleCustomerId) await updatePlan(c.env.DB, userId, { paddleCustomerId: customerId }, now);
      const txn = await createCheckoutTransaction(paddle, customerId, userId, c.req.valid('json').storage);
      return c.json({ transactionId: txn.id, customerId });
    } catch (err) {
      return paddleRefused(err, 'start the checkout', userId);
    }
  })

  /**
   * More storage, or less, on a subscription that exists: the add-on's quantity set to
   * `storage`, prorated and charged now. The answer is the subscription as Paddle has it
   * after the change; the row follows from the webhook, which is what every change to
   * the plan waits for, so the page re-reads its plan rather than trusting this.
   *
   * Less is refused while the account holds more than the smaller quota would allow:
   * the change would go through and every upload after it would be refused, for a
   * reason the person was not shown. The sentence names the numbers; deleting files
   * first is the way. The store's own limit follows the quota (`storeLimitBytes`: a
   * block is a tenth of itself in store room), so the same check is made on the store's
   * size against the smaller limit, or every note write after the change would be the
   * 402 of MAK-234 for a press on this page. One read answers both figures (`usage`).
   */
  .post('/billing/storage', requireAuth, zValidator('json', storageBody), async (c) => {
    const paddle = paddleOf(c.env);
    if (!paddle) return c.json({ error: 'This instance has no plan to sell.' }, 404);
    const userId = c.get('userId')!;
    const row = await planFor(c.env.DB, userId);
    if (!row.paddleSubscriptionId || row.paddleStatus === 'canceled') {
      return c.json({ error: 'Storage is added to a subscription. Subscribe first.' }, 409);
    }
    const storage = c.req.valid('json').storage;
    const after = BASE_STORAGE_GB + STORAGE_ADDON_GB * storage;
    if (after < row.storageGb) {
      const held = await reposFor(c.env, userId, noStoreLimit).attachments.usage();
      if (held.attachmentBytes > storageQuotaBytes(after)) {
        return c.json({ error: `This account holds ${(held.attachmentBytes / GB).toFixed(1)} GB, more than the ${after} GB it would have. Delete some files first.` }, 409);
      }
      const storeLimit = storeLimitBytes(storageQuotaBytes(after));
      if (held.databaseSize > storeLimit) {
        return c.json(
          { error: `This account's notes take ${roomOf(held.databaseSize)} of room, more than the ${roomOf(storeLimit)} they would have. Delete some notes or clear their history, and empty the trash, first.` },
          409,
        );
      }
    }
    try {
      const sub = await setSubscriptionStorage(paddle, row.paddleSubscriptionId, c.req.valid('json').storage);
      return c.json({ status: sub.status, storageGb: BASE_STORAGE_GB + STORAGE_ADDON_GB * c.req.valid('json').storage });
    } catch (err) {
      return paddleRefused(err, 'change the storage', userId);
    }
  })

  /**
   * A link into Paddle's portal, where the person sees their invoices, changes the card
   * and cancels. A fresh session per press: each link is a short-lived token, and one
   * kept would be one that stops working. `cancel` and `payment` are the portal's own
   * deep links into those two forms, for the buttons that name them.
   */
  .get('/billing/portal', requireAuth, async (c) => {
    const paddle = paddleOf(c.env);
    if (!paddle) return c.json({ error: 'This instance has no plan to sell.' }, 404);
    const userId = c.get('userId')!;
    const row = await planFor(c.env.DB, userId);
    if (!row.paddleCustomerId) return c.json({ error: 'Nothing to manage yet: this account has never subscribed.' }, 409);
    try {
      const session = await createPortalSession(paddle, row.paddleCustomerId, row.paddleSubscriptionId);
      const sub = session.urls.subscriptions.find((s) => s.id === row.paddleSubscriptionId);
      return c.json({
        overview: session.urls.general.overview,
        cancel: sub?.cancel_subscription ?? null,
        payment: sub?.update_subscription_payment_method ?? null,
      });
    } catch (err) {
      return paddleRefused(err, 'open the portal', userId);
    }
  })

  /**
   * A read of the subscription as Paddle has it now, applied to the row as an event
   * would be. For the page after a checkout or a portal visit: the webhook usually lands
   * within seconds, but a page that re-reads its plan before it has would say the
   * old thing, and this is the same answer a moment sooner. Also the way back when a
   * webhook was lost for longer than Paddle retries. Writes nothing for an account with
   * no subscription.
   *
   * Stamped with Paddle's own `updated_at`, never this Worker's clock. After a lapse and
   * a second checkout the row still names the old, canceled subscription, and a read of
   * that stamped "now" would be newer than the new subscription's own events, which
   * `notBefore` would then refuse for good: a paying customer kept read-only. So the
   * subscription read is the customer's newest, not the one the row names: a row with
   * none yet (the first checkout, before its webhook has landed, or where none will,
   * which is every local instance) and a row naming a canceled one both find the new
   * subscription this way, and only a subscription that is canceled and newest is left
   * alone, since nothing about it will change.
   */
  .post('/billing/refresh', requireAuth, async (c) => {
    const paddle = paddleOf(c.env);
    if (!paddle) return c.json({ error: 'This instance has no plan to sell.' }, 404);
    const userId = c.get('userId')!;
    const now = Date.now();
    const row = await planFor(c.env.DB, userId, now);
    if (!row.paddleCustomerId) return c.json(accountPlanOf(row, now));
    try {
      const sub =
        row.paddleSubscriptionId && row.paddleStatus !== 'canceled'
          ? await getSubscription(paddle, row.paddleSubscriptionId)
          : await newestSubscription(paddle, row.paddleCustomerId);
      if (sub && sub.status !== 'canceled' && sub.updated_at) {
        const at = eventStamp(sub.updated_at);
        const event: PaddleEvent = { event_id: `read-${at}`, event_type: 'subscription.updated', occurred_at: at, data: sub };
        const patch = planPatchFor(paddle, event, row);
        if (patch) await updatePlanStatement(c.env.DB, userId, patch, now, { notBefore: at }).run();
      }
      return c.json(accountPlanOf(await planFor(c.env.DB, userId, now), now));
    } catch (err) {
      return paddleRefused(err, 'read the subscription', userId);
    }
  })

  /**
   * Paddle's webhook: what happened to a subscription, signed with the destination's
   * secret. No session (Paddle sends none), so the signature is the authority, and the
   * raw body is what it signs, read before anything parses it. Before either, the
   * sender's address must be one Paddle publishes (`webhookSourceOf`): a 403 for any
   * other, and a 503 when Paddle's list cannot be read, which Paddle retries.
   *
   * Two answers for a sound event: 200 having applied it, or 200 having found nothing to
   * apply: an event already applied by id (Paddle retries anything not answered inside
   * five seconds), a customer no row holds (a checkout from the dashboard, a test from
   * the simulator), or a type the rules do not follow. All 200, since a 4xx would be
   * retried until Paddle gave up and then listed as failed for the operator to clear;
   * the log line says which it was. A bad signature is 401 and a body that is not an
   * event is 400, both of which Paddle will retry and both of which are worth seeing
   * fail.
   *
   * The event's row and the plan's change go in one batch, so a row here with no change
   * behind it cannot happen. Subscription and transaction events apply only while the
   * row's newest event is not after this one (`notBefore`), so two deliveries racing
   * both write the same thing and a late one writes nothing. A refund cancel is the
   * exception below.
   *
   * A refund is the one event that acts on Paddle rather than only on the row
   * (`refundEffectOf`): the subscription is cancelled, or its add-on removed, before
   * anything is recorded, so a call Paddle refuses or does not answer is a 502 and the
   * event is delivered again: the row does not yet hold the refund's end, and the retry
   * asks again, even when a cancel that went through unanswered has since made the row
   * canceled. Once the call is through, the row is written as the cancel will leave it,
   * in the same batch as the event's row.
   *
   * That cancel is stamped after the adjustment, and its `subscription.canceled` often
   * lands first: Paddle fires it as the cancel call returns, and the Worker can apply
   * it before this request writes. `planPatchFor` keeps `planUntil` as the year's end
   * on a canceled snapshot (a scheduled cancel at period end must), so `notBefore`
   * would then skip the refund's patch and leave a refunded account writable until
   * that date. A refund cancel therefore writes without `notBefore`, scoped to the
   * subscription it named, and only advances the stamp: the paid period ends, a
   * confirming cancel keeps that date, and a checkout in the same moment is left alone.
   */
  .post('/billing/webhook', async (c) => {
    const paddle = paddleOf(c.env);
    if (!paddle) return c.json({ error: 'Not found' }, 404);
    const address = c.req.header('cf-connecting-ip');
    const source = await webhookSourceOf(paddle, address, c.env.ALLOW_TEST_CREDENTIALS === '1');
    if (source === 'unknown') return c.json({ error: 'Paddle addresses unavailable; deliver again' }, 503);
    if (source === 'refused') {
      console.warn(`[billing] webhook from ${address ?? 'no address'} refused: not one of Paddle's`);
      return c.json({ error: 'Not from Paddle' }, 403);
    }
    const raw = await c.req.text();
    if (!(await verifyWebhookSignature(paddle.webhookSecret, c.req.header('paddle-signature'), raw))) {
      return c.json({ error: 'Bad signature' }, 401);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: 'Not JSON' }, 400);
    }
    const event = eventSchema.safeParse(parsed);
    if (!event.success) return c.json({ error: 'Not a Paddle event' }, 400);
    const { event_id, event_type, data } = event.data;
    const occurred_at = eventStamp(event.data.occurred_at);

    const seen = await c.env.DB.prepare(`SELECT 1 AS seen FROM billing_event WHERE event_id = ?1`).bind(event_id).first();
    if (seen) {
      console.log(`[billing] ${event_type} ${event_id} already applied`);
      return c.json({ applied: false, reason: 'duplicate' });
    }
    const row = data.customer_id ? await planRowByCustomer(c.env.DB, data.customer_id) : null;
    if (!row) {
      console.log(`[billing] ${event_type} ${event_id} names no account (customer ${data.customer_id ?? 'none'})`);
      return c.json({ applied: false, reason: 'no account' });
    }
    const now = Date.now();
    const paddleEvent: PaddleEvent = { event_id, event_type, occurred_at, data: data as unknown as PaddleEvent['data'] };
    let patch = planPatchFor(paddle, paddleEvent, row);
    if (ADJUSTMENT_EVENTS.has(event_type)) {
      const adjustment = paddleEvent.data as PaddleAdjustment;
      let effect = refundEffectOf(paddle, paddleEvent, row);
      try {
        if (effect === 'needs-transaction') {
          const txn = await getTransaction(paddle, adjustment.transaction_id);
          effect = refundEffectOf(paddle, paddleEvent, row, txn.details?.line_items ?? []);
        }
        if (effect === 'cancel') await ensureSubscriptionCanceled(paddle, row.paddleSubscriptionId!);
        if (effect === 'remove-storage') await removeSubscriptionStorage(paddle, row.paddleSubscriptionId!);
      } catch (err) {
        return paddleRefused(err, `act on the refund ${adjustment.id ?? event_id}`, row.userId);
      }
      if (effect === 'cancel' || effect === 'remove-storage') {
        console.log(`[billing] ${event_type} ${event_id} for user=${row.userId}: refund, ${effect === 'cancel' ? 'subscription cancelled' : 'storage add-on removed'}`);
        patch = refundPatchFor(effect, paddleEvent);
      }
    }
    const record = c.env.DB.prepare(`INSERT OR IGNORE INTO billing_event (event_id, event_type, occurred_at, received_at) VALUES (?1, ?2, ?3, ?4)`).bind(
      event_id,
      event_type,
      occurred_at,
      now,
    );
    if (!patch) {
      await record.run();
      console.log(`[billing] ${event_type} ${event_id} for user=${row.userId}: nothing to apply`);
      return c.json({ applied: false, reason: 'not followed' });
    }
    const refundCancel = patch.paddleStatus === 'canceled' && ADJUSTMENT_EVENTS.has(event_type);
    const writeOpts = refundCancel
      ? { onlyIfSubscription: row.paddleSubscriptionId!, advanceStamp: true }
      : { notBefore: occurred_at };
    const [, written] = await c.env.DB.batch([record, updatePlanStatement(c.env.DB, row.userId, patch, now, writeOpts)]);
    // The guard can let the batch succeed and change nothing: an event older than the
    // row's newest, delivered late, or a refund cancel whose subscription the row no
    // longer names (a checkout that landed while we were cancelling). Said as such,
    // since that is the case to see in the log when a row is not where an event should
    // have put it.
    if (!written?.meta.changes) {
      const reason = refundCancel ? 'other subscription' : 'older';
      console.log(
        `[billing] ${event_type} ${event_id} for user=${row.userId}: skipped, ${
          refundCancel ? "row no longer names the refunded subscription" : "older than the row's newest event"
        }`,
      );
      return c.json({ applied: false, reason });
    }
    console.log(`[billing] ${event_type} ${event_id} for user=${row.userId}: ${patch.paddleStatus ?? 'transaction'} until ${patch.planUntil ?? 'as before'}`);
    return c.json({ applied: true });
  });
