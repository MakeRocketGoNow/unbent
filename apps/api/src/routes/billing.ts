import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { BASE_STORAGE_GB, GB, MAX_STORAGE_UNITS, STORAGE_ADDON_GB, storageQuotaBytes, storeLimitBytes } from '@unbent/shared';
import {
  REFUND_EVENTS,
  eventStamp,
  invoiceSubscriptionOf,
  planPatchFor,
  refundEffectOf,
  refundPatchFor,
  storageKeptAfter,
  type RefundEffect,
  type StripeEvent,
} from '../lib/billing-events.js';
import { accountPlanOf, planFor, planRowByCustomer, planStateOf, updatePlan, updatePlanStatement } from '../lib/plan.js';
import {
  ENDED_SUBSCRIPTION,
  StripeError,
  billingOn,
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  ensureSubscriptionCanceled,
  expireOpenCheckouts,
  getCharge,
  getInvoice,
  getSubscription,
  invoicesOfPayment,
  newestSubscription,
  setSubscriptionStorage,
  stripeOf,
  verifyWebhookSignature,
  webhookSourceOf,
  type StripeCharge,
  type StripeConfig,
  type StripeDispute,
  type StripeInvoice,
} from '../lib/stripe.js';
import { noStoreLimit } from '../lib/notes-repo.js';
import { roomOf } from '../lib/quota.js';
import { reposFor } from '../lib/repos.js';
import { requireAuth } from '../lib/session.js';
import type { AppEnv } from '../types.js';

/**
 * The plan (MAK-108): what the signed-in account is on, the checkout and the portal that
 * change it, and Stripe's webhook, which is how the change comes back.
 *
 * Every route here answers 404 where billing is off, the way the account-deletion
 * endpoint does where there is no mail: an instance with nothing to sell has no plan to
 * report, and `/api/config` carries no `billing`, so no client asks.
 *
 * A refusal from Stripe is answered 502 with Stripe's own words, not 500: the request
 * was sound and the fault is on the other side of a network, which is the one thing the
 * person can do something about: try again. Logged with the account, since a 502 the
 * page shows says nothing about which call it was.
 */

const storageBody = z.object({ storage: z.number().int().min(0).max(MAX_STORAGE_UNITS) });

/** The webhook's envelope, as much of it as the route reads before the rules do. */
const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created: z.number().int(),
  data: z.object({ object: z.object({ customer: z.string().nullable().optional() }).passthrough() }),
});

/** The Plan page, where every redirect out of here comes back to. */
function planPageUrl(appUrl: string, query?: string): string {
  return `${appUrl.replace(/\/$/, '')}/settings/plan${query ? `?${query}` : ''}`;
}

function stripeRefused(err: unknown, what: string, userId: string): Response {
  if (!(err instanceof StripeError)) throw err;
  console.error(`[billing] ${what} for user=${userId} refused:`, err.message);
  return Response.json({ error: `Stripe could not ${what} right now. Try again shortly.` }, { status: 502 });
}

/**
 * The invoice a refunded or disputed charge paid, for the refund rules. Since
 * 2025-03-31.basil a charge names no invoice; the way back is its payment intent, the
 * list of invoice payments that intent made, and the first invoice among them that
 * bills a subscription. Null for a charge that paid none: a one-off, or a payment
 * intent Stripe no longer lists.
 */
async function invoiceOfCharge(stripe: StripeConfig, paymentIntentId: string | null): Promise<StripeInvoice | null> {
  if (!paymentIntentId) return null;
  for (const invoiceId of (await invoicesOfPayment(stripe, paymentIntentId)).slice(0, 3)) {
    const invoice = await getInvoice(stripe, invoiceId);
    if (invoiceSubscriptionOf(invoice)) return invoice;
  }
  return null;
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
   * A checkout for the page to send the person to: the plan, with `storage` add-ons
   * beside it. The answer is the address of Stripe's hosted page; the page redirects
   * there, and Stripe sends the person back to the Plan page with `?checkout=complete`
   * once paid, or without it from the back button. A redirect rather than an overlay
   * because Managed Payments' checkout is Stripe's own page: the seller of record's
   * terms are in its footer, Link is its wallet, and nothing of Stripe's runs on ours.
   * The account's customer is ours before the session is made, so the plan row holds
   * Stripe's id for the account by the time the first event names it, and the page
   * never learns a price id.
   *
   * Only for an account with no subscription: one that has one changes it through the
   * portal or `POST /billing/storage`, and a second checkout would be a second
   * subscription for one account, which the row cannot hold. A lapsed subscription
   * (`canceled`, its period over) is the one case a new checkout is right for, since
   * Stripe does not revive a canceled subscription.
   */
  .post('/billing/checkout', requireAuth, zValidator('json', storageBody), async (c) => {
    const stripe = stripeOf(c.env);
    if (!stripe) return c.json({ error: 'This instance has no plan to sell.' }, 404);
    const userId = c.get('userId')!;
    const now = Date.now();
    const row = await planFor(c.env.DB, userId, now);
    const live = row.subscriptionId && !(row.subscriptionStatus === 'canceled' && planStateOf(row, now) === 'inactive');
    if (live) return c.json({ error: 'This account already has a subscription. Manage it from the portal.' }, 409);
    // The page offers a running comp no checkout; the route refuses one too, since the
    // webhook would then ignore the subscription's events (`planPatchFor`) and the
    // person would be charged for a plan the row never took. A comp that has ended is a
    // lapsed account, and subscribes as one.
    if (row.source === 'comp' && planStateOf(row, now) !== 'inactive') {
      return c.json({ error: 'This account is complimentary; there is nothing to pay for.' }, 409);
    }
    try {
      const customerId = row.customerId ?? (await createCustomer(stripe, c.get('user')!.email, userId)).id;
      // The row hears of a paid checkout's subscription only by webhook, so in that lag a
      // second tab still showing Subscribe, or Back from Stripe's success page, would
      // pass the row's check above. Stripe is asked too, for a customer that has one; a
      // paid session is complete rather than open, so expiring sessions does not catch it.
      if (row.customerId) {
        const newest = await newestSubscription(stripe, row.customerId);
        if (newest && !ENDED_SUBSCRIPTION.has(newest.status)) {
          return c.json({ error: 'This account already has a subscription. Manage it from the portal.' }, 409);
        }
      }
      if (customerId !== row.customerId) await updatePlan(c.env.DB, userId, { customerId }, now);
      // Asked even of a customer made a moment ago: a second tab's press gets the same one.
      await expireOpenCheckouts(stripe, customerId);
      const session = await createCheckoutSession(stripe, {
        customerId,
        userId,
        storage: c.req.valid('json').storage,
        successUrl: planPageUrl(c.env.APP_URL, 'checkout=complete'),
        cancelUrl: planPageUrl(c.env.APP_URL),
      });
      if (!session.url) throw new StripeError(502, null, 'the checkout session has no address');
      return c.json({ url: session.url });
    } catch (err) {
      return stripeRefused(err, 'start the checkout', userId);
    }
  })

  /**
   * More storage, or less, on a subscription that exists: the add-on's quantity set to
   * `storage`, prorated and charged now. The answer is the subscription as Stripe has it
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
   *
   * Two calls to Stripe: the subscription is read first, since its items are changed
   * by id (a bare price would be read as a second add-on beside the first).
   */
  .post('/billing/storage', requireAuth, zValidator('json', storageBody), async (c) => {
    const stripe = stripeOf(c.env);
    if (!stripe) return c.json({ error: 'This instance has no plan to sell.' }, 404);
    const userId = c.get('userId')!;
    const row = await planFor(c.env.DB, userId);
    if (!row.subscriptionId || row.subscriptionStatus === 'canceled') {
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
      const current = await getSubscription(stripe, row.subscriptionId);
      const sub = await setSubscriptionStorage(stripe, current, storage, 'charge-now');
      return c.json({ status: sub.status, storageGb: after });
    } catch (err) {
      return stripeRefused(err, 'change the storage', userId);
    }
  })

  /**
   * A link into Stripe's customer portal, where the person sees their invoices, changes
   * the card and cancels. A fresh session per press: each link is short-lived, and one
   * kept would be one that stops working. `?flow=payment` opens it on the card form,
   * for the button that names it; the portal comes back to the Plan page when done.
   */
  .get('/billing/portal', requireAuth, async (c) => {
    const stripe = stripeOf(c.env);
    if (!stripe) return c.json({ error: 'This instance has no plan to sell.' }, 404);
    const userId = c.get('userId')!;
    const row = await planFor(c.env.DB, userId);
    if (!row.customerId) return c.json({ error: 'Nothing to manage yet: this account has never subscribed.' }, 409);
    try {
      const session = await createPortalSession(
        stripe,
        row.customerId,
        planPageUrl(c.env.APP_URL),
        c.req.query('flow') === 'payment' ? 'payment_method_update' : undefined,
      );
      return c.json({ url: session.url });
    } catch (err) {
      return stripeRefused(err, 'open the portal', userId);
    }
  })

  /**
   * A read of the subscription as Stripe has it now, applied to the row as an event
   * would be. For the page after a checkout or a portal visit: the webhook usually lands
   * within seconds, but a page that re-reads its plan before it has would say the
   * old thing, and this is the same answer a moment sooner. Also the way back when a
   * webhook was lost for longer than Stripe retries, and the only way at all on a local
   * instance, which no webhook reaches. Writes nothing for an account with no
   * subscription.
   *
   * The subscription read is the customer's newest, not the one the row names: a row
   * with none yet (the first checkout, before its webhook has landed) and a row naming
   * a canceled one (a lapsed subscriber's second checkout) both find the new
   * subscription this way, and only a subscription that is canceled and newest is left
   * alone, since nothing about it will change.
   *
   * Stamped with the clock, since Stripe's subscription carries no "last changed" time.
   * That is safe here where it was not with Paddle (whose read was stamped with its
   * `updated_at`) because the read is of the newest subscription: a read of an old,
   * canceled one stamped "now" would have refused the new subscription's own events as
   * older for good, but the newest subscription's events describe nothing the read did
   * not already reflect, and an event a second after the read still applies.
   */
  .post('/billing/refresh', requireAuth, async (c) => {
    const stripe = stripeOf(c.env);
    if (!stripe) return c.json({ error: 'This instance has no plan to sell.' }, 404);
    const userId = c.get('userId')!;
    const now = Date.now();
    const row = await planFor(c.env.DB, userId, now);
    if (!row.customerId) return c.json(accountPlanOf(row, now));
    try {
      const sub =
        row.subscriptionId && row.subscriptionStatus !== 'canceled'
          ? await getSubscription(stripe, row.subscriptionId)
          : await newestSubscription(stripe, row.customerId);
      if (sub && sub.status !== 'canceled') {
        const created = Math.floor(now / 1000);
        const event: StripeEvent = { id: `read-${created}`, type: 'customer.subscription.updated', created, data: { object: sub } };
        const patch = planPatchFor(stripe, event, row);
        if (patch) await updatePlanStatement(c.env.DB, userId, patch, now, { notBefore: eventStamp(created) }).run();
      }
      return c.json(accountPlanOf(await planFor(c.env.DB, userId, now), now));
    } catch (err) {
      return stripeRefused(err, 'read the subscription', userId);
    }
  })

  /**
   * Stripe's webhook: what happened to a subscription, signed with the endpoint's
   * secret. No session (Stripe sends none), so the signature is the authority, and the
   * raw body is what it signs, read before anything parses it. Before either, the
   * sender's address must be one Stripe publishes (`webhookSourceOf`): a 403 for any
   * other, and a 503 when Stripe's list cannot be read, which Stripe retries.
   *
   * Two answers for a sound event: 200 having applied it, or 200 having found nothing to
   * apply: an event already applied by id (Stripe retries anything not answered 2xx,
   * for three days), a customer no row holds (a checkout from the dashboard, a test
   * from the CLI), or a type the rules do not follow. All 200, since a 4xx would be
   * retried until Stripe gave up and then listed as failed for the operator to clear;
   * the log line says which it was. A bad signature is 401 and a body that is not an
   * event is 400, both of which Stripe will retry and both of which are worth seeing
   * fail.
   *
   * The event's row and the plan's change go in one batch, so a row here with no change
   * behind it cannot happen. Subscription and invoice events apply only while the
   * row's newest event is not after this one (`notBefore`), so two deliveries racing
   * both write the same thing and a late one writes nothing. A refund cancel is the
   * exception below.
   *
   * A refund is the one event that acts on Stripe rather than only on the row
   * (`refundEffectOf`): the subscription is cancelled, or its add-on removed, before
   * anything is recorded, so a call Stripe refuses or does not answer is a 502 and the
   * event is delivered again: the row does not yet hold the refund's end, and the retry
   * asks again, even when a cancel that went through unanswered has since made the row
   * canceled. Once the call is through, the row is written as the cancel will leave it,
   * in the same batch as the event's row. The charge names no subscription on this API
   * version, so the invoice it paid is read first (`invoiceOfCharge`), and a dispute
   * names no customer either, so its charge is read for one.
   *
   * That cancel is stamped after the refund, and its `customer.subscription.deleted`
   * often lands first: Stripe fires it as the cancel call returns, and the Worker can
   * apply it before this request writes. `planPatchFor` keeps `planUntil` as the
   * year's end on a canceled snapshot (a cancel at the period's end must), so
   * `notBefore` would then skip the refund's patch and leave a refunded account
   * writable until that date. A refund cancel therefore writes without `notBefore`,
   * scoped to the subscription it named, and only advances the stamp: the paid period
   * ends, a confirming cancel keeps that date, and a checkout in the same moment is
   * left alone.
   */
  .post('/billing/webhook', async (c) => {
    const stripe = stripeOf(c.env);
    if (!stripe) return c.json({ error: 'Not found' }, 404);
    const address = c.req.header('cf-connecting-ip');
    const source = await webhookSourceOf(address, c.env.ALLOW_TEST_CREDENTIALS === '1');
    if (source === 'unknown') return c.json({ error: 'Stripe addresses unavailable; deliver again' }, 503);
    if (source === 'refused') {
      console.warn(`[billing] webhook from ${address ?? 'no address'} refused: not one of Stripe's`);
      return c.json({ error: 'Not from Stripe' }, 403);
    }
    const raw = await c.req.text();
    if (!(await verifyWebhookSignature(stripe.webhookSecret, c.req.header('stripe-signature'), raw))) {
      return c.json({ error: 'Bad signature' }, 401);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: 'Not JSON' }, 400);
    }
    const event = eventSchema.safeParse(parsed);
    if (!event.success) return c.json({ error: 'Not a Stripe event' }, 400);
    const { id, type, created, data } = event.data;
    const occurredAt = eventStamp(created);

    const seen = await c.env.DB.prepare(`SELECT 1 AS seen FROM billing_event WHERE event_id = ?1`).bind(id).first();
    if (seen) {
      console.log(`[billing] ${type} ${id} already applied`);
      return c.json({ applied: false, reason: 'duplicate' });
    }
    // A dispute names its charge and no customer; the charge has both the customer and
    // the payment intent the refund rules will need.
    let charge: StripeCharge | undefined;
    let customerId = data.object.customer ?? null;
    if (type === 'charge.dispute.created') {
      try {
        charge = await getCharge(stripe, (data.object as unknown as StripeDispute).charge);
      } catch (err) {
        return stripeRefused(err, `read the disputed charge of ${id}`, 'unknown');
      }
      customerId = charge.customer;
    } else if (type === 'charge.refunded') {
      charge = data.object as unknown as StripeCharge;
    }
    const row = customerId ? await planRowByCustomer(c.env.DB, customerId) : null;
    if (!row) {
      console.log(`[billing] ${type} ${id} names no account (customer ${customerId ?? 'none'})`);
      return c.json({ applied: false, reason: 'no account' });
    }
    const now = Date.now();
    const stripeEvent: StripeEvent = { id, type, created, data: data as unknown as StripeEvent['data'] };
    let patch = planPatchFor(stripe, stripeEvent, row);
    let effect: RefundEffect | null = null;
    if (REFUND_EVENTS.has(type)) {
      effect = refundEffectOf(stripe, stripeEvent, row);
      let invoice: StripeInvoice | null = null;
      let keptUnits = 0;
      try {
        if (effect === 'needs-invoice') {
          invoice = await invoiceOfCharge(stripe, charge?.payment_intent ?? null);
          effect = refundEffectOf(stripe, stripeEvent, row, invoice);
        }
        if (effect === 'cancel') await ensureSubscriptionCanceled(stripe, row.subscriptionId!);
        if (effect === 'remove-storage') {
          const sub = await getSubscription(stripe, row.subscriptionId!);
          const current = sub.items.data.find((i) => i.price.id === stripe.storagePriceId)?.quantity ?? 0;
          keptUnits = storageKeptAfter(stripe, invoice, current);
          await setSubscriptionStorage(stripe, sub, keptUnits, 'no-charge');
        }
      } catch (err) {
        return stripeRefused(err, `act on the refund ${id}`, row.userId);
      }
      if (effect === 'cancel' || effect === 'remove-storage') {
        console.log(`[billing] ${type} ${id} for user=${row.userId}: refund, ${effect === 'cancel' ? 'subscription cancelled' : 'storage add-on removed'}`);
        patch = refundPatchFor(effect, stripeEvent, keptUnits);
      }
    }
    const record = c.env.DB.prepare(`INSERT OR IGNORE INTO billing_event (event_id, event_type, occurred_at, received_at) VALUES (?1, ?2, ?3, ?4)`).bind(
      id,
      type,
      occurredAt,
      now,
    );
    if (!patch) {
      await record.run();
      console.log(`[billing] ${type} ${id} for user=${row.userId}: nothing to apply`);
      return c.json({ applied: false, reason: 'not followed' });
    }
    // `refundEffectOf` has checked that the row names the refunded subscription.
    const refundCancel = effect === 'cancel';
    const writeOpts = refundCancel ? { onlyIfSubscription: row.subscriptionId!, advanceStamp: true } : { notBefore: occurredAt };
    const [, written] = await c.env.DB.batch([record, updatePlanStatement(c.env.DB, row.userId, patch, now, writeOpts)]);
    // The guard can let the batch succeed and change nothing: an event older than the
    // row's newest, delivered late, or a refund cancel whose subscription the row no
    // longer names (a checkout that landed while we were cancelling). Said as such,
    // since that is the case to see in the log when a row is not where an event should
    // have put it.
    if (!written?.meta.changes) {
      const [reason, why] = refundCancel
        ? ['other subscription', 'row no longer names the refunded subscription']
        : ['older', "older than the row's newest event"];
      console.log(`[billing] ${type} ${id} for user=${row.userId}: skipped, ${why}`);
      return c.json({ applied: false, reason });
    }
    console.log(`[billing] ${type} ${id} for user=${row.userId}: ${patch.subscriptionStatus ?? 'invoice'} until ${patch.planUntil ?? 'as before'}`);
    return c.json({ applied: true });
  });
