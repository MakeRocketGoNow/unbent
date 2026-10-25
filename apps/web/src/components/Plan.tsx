import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  BASE_STORAGE_GB,
  FREE_NOTES,
  FREE_STORAGE_GB,
  GB,
  MAX_STORAGE_UNITS,
  PLAN_PRICE_USD,
  STORAGE_ADDON_GB,
  STORAGE_ADDON_PRICE_USD,
  fitsFree,
  storageQuotaBytes,
  storeLimitBytes,
  type AccountPlan,
  type AutofillUsage,
} from '@unbent/shared';
import * as api from '../notes-api.js';
import { errorText } from '../notes-api.js';
import { isHosted } from '../app-bridge.js';
import { formatBytes } from '../format-bytes.js';
import { autofillUsageQuery, configQuery, keys, planUsageQuery } from '../queries.js';
import { usePlan } from '../use-plan.js';
import { Button } from './Button.js';
import { Confirm } from './Confirm.js';
import { Snackbar } from './Snackbar.js';
import { formatDay } from './format-when.js';

/**
 * The most storage blocks the page lists: two hundred gigabytes on top is past any
 * archive this app has seen, and a list of forty is a list nobody reads. The API allows
 * `MAX_STORAGE_UNITS`, for an operator's or a support request.
 */
const MAX_UNITS = Math.min(8, MAX_STORAGE_UNITS);

/** How many add-on blocks a quota is, for the storage control. */
function unitsOf(plan: AccountPlan): number {
  return Math.max(0, Math.round((plan.storageGb - BASE_STORAGE_GB) / STORAGE_ADDON_GB));
}

const dollars = (n: number) => `$${n}`;

/** The share of a bound at which the meter turns the full colour: near enough that the next large file or import may be refused. */
const FULL_SHARE = 0.95;

/** How often, and how many times, the plan is read back from Stripe after a checkout; see `settleCheckout`. */
const CHECKOUT_SETTLE_WAIT_MS = 1500;
const CHECKOUT_SETTLE_TRIES = 6;

/** Where the browser is sent for the checkout and the portal. A seam for the tests, which cannot leave the page. */
export const leavePage = { to: (url: string) => window.location.assign(url) };

/**
 * The account's plan (MAK-108): where it stands, what it holds, and the three things
 * that change it: subscribing, managing the subscription in Stripe's portal, and buying
 * more storage. Drawn only where the instance sells a plan (`config.billing`).
 *
 * One state at a time, in a sentence: a trial and when it ends, a subscription and when
 * it renews or cancels, a comp, or read-only and what that still allows. Subscribe is
 * the one `primary` on the page and appears only where it is the thing to do; a
 * subscribed account gets the portal instead, since cancelling and changing the card are
 * Stripe's forms, not this app's.
 *
 * Inside the Android and iOS apps the buttons are not drawn at all. Both stores forbid
 * selling a subscription in an app through anything but their own billing, and a button
 * that opens a web checkout inside the app is the thing a review rejects. The page says
 * where to go instead, and nothing else changes: the plan is the account's, not the
 * device's.
 *
 * The checkout is Stripe's own page, reached by redirect from a session the server made,
 * so the page never learns a price id and the account's Stripe customer exists before
 * the person leaves. A redirect rather than an overlay because Managed Payments'
 * checkout is the seller of record's page, with its terms in the footer and nothing of
 * Stripe's running on ours. Stripe sends the person back here with `?checkout=complete`
 * once paid, and the plan is then read back from Stripe at once rather than waiting on
 * the webhook: the page should say "Subscribed" on arrival, not a few seconds later.
 */
export function Plan() {
  const { billing, plan: standing, unavailable } = usePlan();
  // This page alone asks the store what the account holds; the banner and the editor
  // read the plan without it. The two answers are the same row, but only the figures are
  // taken from the heavier one: the plan's state is the light read's, which every page
  // shares and which a change to the plan refetches with the same key. The usage read
  // used to stand in for the whole plan once it had arrived, and a refetch of it that
  // failed or was cut short keeps its last answer (the query library leaves `data` in
  // place under an error), so the first live checkout came back to a page saying "Free
  // trial" with the figures beside it, over a row that had just gone active, until a
  // reload (2026-10-22). The figures are the account's bytes, which no plan change
  // alters, so an older pair under a newer state is still true.
  const usage = useQuery(planUsageQuery(standing !== undefined));
  const plan: AccountPlan | undefined = standing && {
    ...standing,
    usedBytes: usage.data?.usedBytes,
    storeBytes: usage.data?.storeBytes,
    notes: usage.data?.notes,
  };
  // No plan holding: free under the free plan's limits, read-only past them. Both are
  // measured against the free plan, so both draw its meters and both are offered it.
  const lapsed = plan?.state === 'free' || plan?.state === 'inactive';
  // The free plan's Auto-fill pool, for its meter: only where the instance has Auto-fill
  // and the account is on the free plan, and from the read Maintenance makes, which
  // answers it (`AutofillUsage.freePresses`).
  const config = useQuery(configQuery());
  const pool = useQuery({ ...autofillUsageQuery(), enabled: lapsed && config.data?.autofill === true });
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'checkout' | 'settling' | 'portal' | 'storage' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The storage row's own, drawn under it: a refusal there answered under the
  // subscription's heading, a section above, read as about the wrong control.
  const [storageError, setStorageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [units, setUnits] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const hosted = isHosted();
  const navigate = useNavigate();
  // `checkout=complete` is what Stripe sends the person back with once a checkout is
  // paid: the server puts it on the success address it hands Stripe (`planPageUrl` in
  // routes/billing.ts), and the route validates it (`settings.plan.tsx`). Read loosely,
  // since the page is also drawn under a bare root in its tests.
  const { checkout } = useSearch({ strict: false }) as { checkout?: string };
  const settled = useRef(false);

  // Back from a paid checkout: read the plan until it names the subscription, then say
  // so, and take the query off the address (through the router, which owns it) so a
  // reload or a bookmark does not read the plan back again. Once per page, however the
  // queries refetch. The thanks waits for the subscription itself: the address is all
  // the evidence there is otherwise, and it can be typed, so one that finds nothing
  // only says the plan will follow.
  useEffect(() => {
    if (settled.current || !billing || checkout !== 'complete') return;
    settled.current = true;
    void navigate({ to: '/settings/plan', search: {}, replace: true });
    setBusy('settling');
    void settleCheckout()
      .then(async (found) => {
        await queryClient.invalidateQueries({ queryKey: keys.plan() });
        setNotice(found ? 'You’re subscribed. Thank you.' : 'Your plan will update once Stripe confirms the payment.');
      })
      .finally(() => setBusy(null));
    // `settleCheckout`, `navigate` and the query client are stable for the page's life;
    // the effect is about the address, read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billing, checkout]);

  // `subscribe` leaves the button busy as the browser leaves for Stripe. The browser's
  // own Back can restore this page from its back/forward cache with that state intact,
  // and the button would stay disabled until a reload; Stripe's back link is a fresh
  // load and needs none of this.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(null);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  if (!billing) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Plan</h2>
        </div>
        <p className="muted small">This instance sells no plan: every account is active, with nothing to pay for.</p>
      </div>
    );
  }
  if (!plan) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Plan</h2>
        </div>
        {/* A read that failed (offline, or the server's day) says so and offers the one
            thing to do, rather than "Reading…" for as long as the page is open. */}
        {unavailable ? (
          <div className="backfill-row">
            <span className="bad small">Your plan could not be read right now.</span>
            <Button size="small" onClick={() => void queryClient.invalidateQueries({ queryKey: keys.plan() })}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="muted small">Reading your plan…</p>
        )}
      </div>
    );
  }

  // The checkout route's line, word for word: only a canceled subscription whose period
  // is over makes way for a new checkout. One still in its paid period, cancelling or
  // not, is managed in the portal; and a past-due one past its paid period is read-only
  // until the card is updated, which is the portal's form too: a new checkout would be
  // a second subscription beside the one Stripe is still trying to collect.
  const subscribed = plan.subscription !== null && !(plan.subscription.status === 'canceled' && lapsed);
  // A comp still running is asked for nothing; one that has ended is a lapsed account
  // like any other, free or read-only, and the checkout is its way on: the operator's
  // "end" and a dated comp running out both leave `source` as it was, so the source alone
  // cannot say.
  const canSubscribe = !hosted && !subscribed && !(plan.source === 'comp' && !lapsed);
  // Storage is changed on a subscription Stripe will bill; a canceled one is refused.
  const canChangeStorage = subscribed && plan.subscription?.status !== 'canceled';
  const chosenUnits = units ?? unitsOf(plan);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.plan() });
  // Less storage than the account holds would refuse every upload after it; the server
  // refuses the change, and the button says why before the press. The store's limit
  // follows the quota, so a block is store room too, and a store that would be over the
  // smaller limit is the same refusal for notes (MAK-234): checked here for the same
  // reason, with the figures the page already has.
  const smaller = storageQuotaBytes(plan.storageGb - STORAGE_ADDON_GB);
  const overSmaller = plan.usedBytes === undefined || plan.usedBytes > smaller;
  const storeOverSmaller = plan.storeBytes !== undefined && plan.storeBytes > storeLimitBytes(smaller);

  /**
   * To Stripe's checkout page. The button stays busy until the browser has left, since
   * a redirect takes a moment and a second press would make a second session.
   */
  async function subscribe() {
    setBusy('checkout');
    setError(null);
    try {
      const { url } = await api.startCheckout(chosenUnits);
      leavePage.to(url);
    } catch (err) {
      setError(errorText(err) || 'The checkout could not be opened.');
      setBusy(null);
    }
  }

  /**
   * The plan read back from Stripe (`refreshPlan`), kept as the plan from this moment.
   * The answer is the row as the server has just written it, and the refetch that
   * follows may fail or be cut short, which leaves what was there: the trial after a
   * checkout, "renews" after a cancellation in the portal, the old size after a storage
   * change. An answer that changed nothing is the row as it stands, so keeping it is
   * harmless. A read that fails leaves the cache alone.
   */
  async function readBack(): Promise<AccountPlan | undefined> {
    const read = await api.refreshPlan().catch(() => undefined);
    if (read) queryClient.setQueryData(keys.plan(), read);
    return read;
  }

  /**
   * The plan read back from Stripe until it names a subscription, a few times over a
   * few seconds. Stripe sends the person back the moment the payment is confirmed, and
   * its subscription and invoice events follow a moment after, so the first read can
   * find the customer with no subscription yet and the page would say "Subscribed" over
   * a banner that still said read-only, until a focus or a reload. Bounded: a read that
   * keeps finding nothing is the webhook's to settle, and the page shows what it has.
   *
   * Not any subscription: a lapsed subscriber coming back still has the old, canceled
   * one on the row, and the first read finds that one as newest until Stripe has made
   * the new one. Settled means a subscription that is not canceled, and the answer is
   * whether one was found.
   */
  async function settleCheckout(): Promise<boolean> {
    for (let attempt = 0; attempt < CHECKOUT_SETTLE_TRIES; attempt++) {
      const read = await readBack();
      if (read?.subscription && read.subscription.status !== 'canceled') return true;
      await new Promise((r) => setTimeout(r, CHECKOUT_SETTLE_WAIT_MS));
    }
    return false;
  }

  /**
   * The portal opens in a new tab, which has to be opened before the link is fetched:
   * a `window.open` after an `await` is a pop-up to the browser, and blocked. So the tab
   * is opened blank on the press and pointed at the link when it arrives; a browser that
   * refused even that is sent there in this tab instead.
   *
   * What was done there is read back when this tab is next looked at: a cancellation or
   * a new card is Stripe's news, and the webhook may or may not have landed by then, so
   * the subscription is read from Stripe rather than the row (`refreshPlan`). Once, on
   * the first return, since the listener is removed as it fires.
   */
  async function openPortal(which: 'overview' | 'payment') {
    setBusy('portal');
    setError(null);
    const tab = window.open('', '_blank');
    try {
      const { url } = await api.portalLink(which);
      if (tab) tab.location.href = url;
      else leavePage.to(url);
      const onReturn = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', onReturn);
        void readBack().then(refresh);
      };
      document.addEventListener('visibilitychange', onReturn);
    } catch (err) {
      tab?.close();
      setError(errorText(err) || 'The portal could not be opened.');
    } finally {
      setBusy(null);
    }
  }

  async function changeStorage(next: number) {
    setBusy('storage');
    setStorageError(null);
    try {
      await api.setStorage(next);
      await readBack();
      await refresh();
      setNotice(next > unitsOf(plan!) ? `Added ${STORAGE_ADDON_GB} GB.` : `Removed ${STORAGE_ADDON_GB} GB.`);
      // Closed once the change has landed, so the confirm's own "Adding…" is what waits.
      setAdding(false);
    } catch (err) {
      setStorageError(errorText(err) || 'The storage could not be changed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Plan</h2>
      </div>

      <p className="muted small">
        Free for up to {FREE_NOTES} notes and {FREE_STORAGE_GB} GB of files, with everything else
        included. One plan, {dollars(PLAN_PRICE_USD)} a year, for unlimited notes and{' '}
        {BASE_STORAGE_GB} GB of files, and {STORAGE_ADDON_GB} GB more for{' '}
        {dollars(STORAGE_ADDON_PRICE_USD)} a year each.
      </p>

      <section className="settings-section">
        <PlanState plan={plan} />
        {hosted && (
          <p className="muted small">
            Subscriptions are managed on the web: open {window.location.host} in a browser and go to
            Settings → Plan.
          </p>
        )}
        {canSubscribe && (
          <>
            <label className="plan-storage-choice">
              <span>Storage</span>
              <select className="search-field" value={chosenUnits} onChange={(e) => setUnits(Number(e.target.value))} disabled={busy !== null}>
                {Array.from({ length: MAX_UNITS + 1 }, (_, n) => (
                  <option key={n} value={n}>
                    {BASE_STORAGE_GB + n * STORAGE_ADDON_GB} GB
                    {n === 0 ? ' (included)' : ` (+${dollars(n * STORAGE_ADDON_PRICE_USD)} a year)`}
                  </option>
                ))}
              </select>
            </label>
            <div className="backfill-row">
              <Button variant="primary" disabled={busy !== null} onClick={() => void subscribe()}>
                {busy === 'checkout' ? 'Opening checkout…' : busy === 'settling' ? 'Confirming your subscription…' : `Subscribe for ${dollars(PLAN_PRICE_USD + chosenUnits * STORAGE_ADDON_PRICE_USD)} a year`}
              </Button>
            </div>
          </>
        )}
        {subscribed && !hosted && (
          <div className="backfill-row">
            <Button disabled={busy !== null} onClick={() => void openPortal('overview')}>
              {busy === 'portal' ? 'Opening…' : 'Manage subscription'}
            </Button>
            {plan.subscription?.pastDue && (
              <Button disabled={busy !== null} onClick={() => void openPortal('payment')}>
                Update payment method
              </Button>
            )}
            <span className="muted small">Invoices, the card, and cancelling, in Stripe’s billing portal.</span>
          </div>
        )}
        {error && <p className="bad small">{error}</p>}
      </section>

      {lapsed ? (
        <section className="settings-section">
          {/* Not "Free plan": the state's own heading above already says that, and two
              headings of one name a section apart read as a repeat. */}
          <h3>Usage</h3>
          <FreeMeters plan={plan} reading={usage.isPending} pool={pool.data?.freePresses ?? null} />
        </section>
      ) : (
        <section className="settings-section">
          <h3>Storage</h3>
          <StorageMeter plan={plan} reading={usage.isPending} />
          {canChangeStorage && !hosted && !adding && (
            <div className="backfill-row">
              {/* Its press opens the confirm, which hides this row while it is open, so the
                  confirm's own "Adding…" is the only busy label Add ever needs. */}
              <Button
                size="small"
                disabled={busy !== null || unitsOf(plan) >= MAX_STORAGE_UNITS}
                tip={unitsOf(plan) >= MAX_STORAGE_UNITS ? 'The most storage a plan can hold; ask for more' : undefined}
                onClick={() => setAdding(true)}
              >
                Add {STORAGE_ADDON_GB} GB
              </Button>
              {unitsOf(plan) > 0 && (
                <Button
                  size="small"
                  variant="quiet"
                  disabled={busy !== null || overSmaller || storeOverSmaller}
                  tip={
                    plan.usedBytes === undefined
                      ? usage.isPending
                        ? 'Reading what the account holds…'
                        : 'What the account holds could not be read'
                      : overSmaller
                        ? `The account holds more than ${plan.storageGb - STORAGE_ADDON_GB} GB; delete some files first`
                        : storeOverSmaller
                          ? `The notes take more than the ${formatBytes(storeLimitBytes(smaller))} of room they would have; delete some notes or clear their history, and empty the trash, first`
                          : undefined
                  }
                  onClick={() => void changeStorage(unitsOf(plan) - 1)}
                >
                  {busy === 'storage' ? 'Removing…' : `Remove ${STORAGE_ADDON_GB} GB`}
                </Button>
              )}
              <span className="muted small">{dollars(STORAGE_ADDON_PRICE_USD)} a year per {STORAGE_ADDON_GB} GB.</span>
            </div>
          )}
          {storageError && <p className="bad small">{storageError}</p>}
          {/* A charge on the card is a confirm, not a press: the amount and when it is
              taken are the question, in the box with the action. */}
          {adding && (
            <Confirm
              label="Confirm adding storage"
              question={<>Add {STORAGE_ADDON_GB} GB for {dollars(STORAGE_ADDON_PRICE_USD)} a year?</>}
              detail="Charged to the card on file now, for the rest of this year, and in full with each renewal."
              actions={[{ label: `Add ${STORAGE_ADDON_GB} GB`, busyLabel: 'Adding…', tone: 'primary', onConfirm: () => changeStorage(unitsOf(plan!) + 1) }]}
              busy={busy !== null}
              onCancel={() => setAdding(false)}
            />
          )}
        </section>
      )}

      {notice && <Snackbar message={notice} tone="info" duration={6000} onDismiss={() => setNotice(null)} />}
    </div>
  );
}

/**
 * Where the account stands, as a title and a sentence: the Plan page's heading, to the
 * person whose plan it is, and the operator page's line about someone else's account.
 * One function with both voices side by side, so the two cannot drift: an operator is
 * not the one being asked to subscribe or to update a card, and a sentence rewritten by
 * pattern from the other voice broke the moment a sentence changed.
 */
export function describePlan(plan: AccountPlan, voice: 'owner' | 'operator' = 'owner'): { title: string; sentence: string } {
  const sub = plan.subscription;
  const own = voice === 'owner';
  // Before the read-only case: a renewal Stripe could not collect leaves the account
  // read-only past its paid period, and the way back is the card, not a new checkout.
  if (sub?.pastDue) {
    const free = plan.state === 'free';
    const lapsed = plan.state === 'inactive';
    return {
      title: 'Payment failed',
      sentence: own
        ? free
          ? `The last renewal could not be collected, so the account is on the free plan until the card is updated: up to ${FREE_NOTES} notes and ${FREE_STORAGE_GB} GB of files. Stripe will try again once it is.`
          : lapsed
            ? 'The last renewal could not be collected, so the account is read-only. Update the card to edit again; Stripe will try again once it is.'
            : `The last renewal could not be collected. Stripe will try again; update the card to keep the plan${plan.until ? ` past ${formatDay(plan.until)}` : ''}.`
        : free
          ? 'The last renewal could not be collected, and the account is on the free plan until the card is updated.'
          : lapsed
            ? 'The last renewal could not be collected, and the account is read-only until the card is updated.'
            : `The last renewal could not be collected. Stripe is retrying; the plan lapses${plan.until ? ` past ${formatDay(plan.until)}` : ''} unless the card is updated.`,
    };
  }
  // What ended, in the person's words: the trial, the subscription, or the plan an
  // operator gave. The row keeps its source when it lapses, which is how this can say.
  const which = plan.source === 'stripe' ? 'subscription' : plan.source === 'comp' ? 'plan' : 'trial';
  const ended = plan.until ? `ended on ${formatDay(plan.until)}` : 'has ended';
  if (plan.state === 'free') {
    return {
      title: 'Free plan',
      sentence: own
        ? `Your ${which} ${ended}, and this account is on the free plan: up to ${FREE_NOTES} notes and ${FREE_STORAGE_GB} GB of files, with everything else as it was. Subscribe for unlimited notes and ${BASE_STORAGE_GB} GB.`
        : `Their ${which} ${ended}; the account is on the free plan.`,
    };
  }
  if (plan.state === 'inactive') {
    return {
      title: 'Read-only',
      sentence: own
        ? `Your ${which} ${ended}, and this account holds more than the free plan's ${FREE_NOTES} notes or ${FREE_STORAGE_GB} GB of files, so it is read-only. Everything still opens, searches and exports. Delete down to the free plan and empty the trash, or subscribe, to edit again.`
        : `Their ${which} ${ended}, and the account is past the free plan. Everything still opens and exports; nothing can be edited until they delete down to it, subscribe or are comped.`,
    };
  }
  if (plan.state === 'trial') {
    const ends = plan.until ? `ends on ${formatDay(plan.until)}` : 'is under way';
    return {
      title: 'Free trial',
      sentence: own ? `Your trial ${ends}. ${trialOutcome(plan)}Nothing is charged until you subscribe.` : `Their trial ${ends}.`,
    };
  }
  if (plan.source === 'comp') {
    const until = plan.until ? `until ${formatDay(plan.until)}` : 'with no end date';
    return { title: 'Complimentary', sentence: `${own ? 'This account' : 'The account'} is on the house, ${until}.` };
  }
  if (sub?.cancelsAt) {
    const ends = `The subscription ends on ${formatDay(sub.cancelsAt)}.`;
    return {
      title: 'Cancelling',
      sentence: own ? `${ends} Your notes stay readable and exportable after that.` : `${ends} The account turns read-only then.`,
    };
  }
  return { title: 'Subscribed', sentence: plan.until ? `Renews on ${formatDay(plan.until)}.` : 'Active.' };
}

/**
 * What the end of a trial will leave the account as, from what it holds now, with its
 * own numbers: the free plan if it fits, read-only if not. Said beside the date because
 * an importer who brought a thousand notes in should know before the day, not on it. A
 * sentence and its space, or nothing while the figures have not been read (the operator
 * page, which has none, and the moment before the Plan page's usage read answers).
 */
function trialOutcome(plan: AccountPlan): string {
  if (plan.notes === undefined || plan.usedBytes === undefined) return '';
  const held = { notes: plan.notes, attachmentBytes: plan.usedBytes };
  if (fitsFree(held)) {
    const files = held.attachmentBytes === 0 ? 'no files' : `${formatBytes(held.attachmentBytes)} of files`;
    return `With ${notesOf(held.notes)} and ${files}, this account stays free then, up to ${FREE_NOTES} notes and ${FREE_STORAGE_GB} GB. `;
  }
  const over = [held.notes > FREE_NOTES ? notesOf(held.notes) : null, held.attachmentBytes > FREE_STORAGE_GB * GB ? `${formatBytes(held.attachmentBytes)} of files` : null].filter(Boolean).join(' and ');
  return `With ${over}, this account becomes read-only then; within the free plan's ${FREE_NOTES} notes and ${FREE_STORAGE_GB} GB it would stay free. `;
}

const notesOf = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'note' : 'notes'}`;

/** The state in a heading and a sentence; see `describePlan`. */
function PlanState({ plan }: { plan: AccountPlan }) {
  const { title, sentence } = describePlan(plan);
  return (
    <>
      <h3>{title}</h3>
      <p>{sentence}</p>
    </>
  );
}

/**
 * The free plan's three meters, for an account no plan holds: its notes against
 * `FREE_NOTES`, counting the trash, as the free plan counts them; its files against
 * `FREE_STORAGE_GB`, with the store's line under them as every account has; and the
 * Auto-fill pool, where the instance has one. Drawn for a read-only account too, since
 * its way out is the free plan, and the meters say how far over it is and which of the
 * two to delete.
 *
 * One rhythm for the three: a line saying what, then its bar, a step apart, with the
 * paragraph's gap between meters, so they read as a set rather than as three widgets.
 * A bar turns the full colour at the share `StorageMeter`'s does, and at the limit
 * itself, where the next note or file is the one refused.
 */
function FreeMeters({ plan, reading, pool }: { plan: AccountPlan; reading: boolean; pool: NonNullable<AutofillUsage['freePresses']> | null }) {
  const quota = storageQuotaBytes(FREE_STORAGE_GB);
  const store = plan.storeBytes !== undefined ? { bytes: plan.storeBytes, limit: storeLimitBytes(quota) } : undefined;
  return (
    <div className="plan-meters">
      <Meter
        label="Notes held"
        max={FREE_NOTES}
        value={plan.notes}
        text={plan.notes !== undefined ? `Notes: ${plan.notes.toLocaleString('en-US')} of ${FREE_NOTES}, counting the trash.` : reading ? `Reading the notes held, of ${FREE_NOTES}…` : `The notes held could not be read right now; the free plan holds ${FREE_NOTES}.`}
      />
      <div>
        <Meter
          label="Files stored"
          max={quota}
          value={plan.usedBytes}
          text={plan.usedBytes !== undefined ? `Files: ${formatBytes(plan.usedBytes)} of ${FREE_STORAGE_GB} GB.` : reading ? `Reading what is held, of ${FREE_STORAGE_GB} GB…` : `Usage could not be read right now; the free plan holds ${FREE_STORAGE_GB} GB of files.`}
        />
        {store && (
          <p className="muted small plan-meter-note">
            Notes, their history and the text read from files:{' '}
            <span className={store.bytes / store.limit >= FULL_SHARE ? 'bad' : undefined}>
              {formatBytes(store.bytes)} of {formatBytes(store.limit)} used.
            </span>
          </p>
        )}
      </div>
      {pool && (
        <Meter
          label="Auto-fill presses used"
          max={pool.of}
          value={pool.used}
          text={`Auto-fill: ${Math.min(pool.used, pool.of)} of ${pool.of} presses used${pool.used >= pool.of ? '; a subscription comes with more' : ''}.`}
        />
      )}
    </div>
  );
}

/** One of the free plan's meters: what it measures, in words, then the bar. No `aria-valuenow` while the figure is unknown. */
function Meter({ label, max, value, text }: { label: string; max: number; value: number | undefined; text: string }) {
  const share = value === undefined ? 0 : Math.min(1, value / max);
  const full = value !== undefined && (share >= FULL_SHARE || value >= max);
  return (
    <div className="plan-free-meter">
      <p className="muted small">{text}</p>
      <div className="progress-bar plan-meter" role="meter" aria-valuemin={0} aria-valuemax={max} {...(value !== undefined ? { 'aria-valuenow': value } : {})} aria-label={label}>
        <div className={`progress-fill${full ? ' plan-meter-full' : ''}`} style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
    </div>
  );
}

/**
 * What the account holds against what it may: a bar and the numbers for its files, and
 * a line for its store. `reading` while the store has not answered yet.
 *
 * Two bounds, because the plan sells room for files and the store has a bound of its
 * own (MAK-234): a note write past it is refused with a sentence that sends people here.
 * Before this the page showed files alone, so someone arriving after that refusal read
 * "2 GB of 10 GB used" under a message that their notes were full. The files keep the
 * bar, since they are what the blocks below buy; the store gets a line in the same
 * rhythm, named for what counts in it rather than a label and a footnote, and its figure
 * turns the bar's full colour at the same share the bar does, so a store that is the
 * reason for the visit stands out without a second bar that would weigh it the same as
 * the thing being sold. Both lines are the same shape (what, then the figure) so they
 * read as a pair; the store's is drawn while the figure is still being read, as a
 * placeholder, so the row of buttons under them does not move when it arrives.
 */
function StorageMeter({ plan, reading }: { plan: AccountPlan; reading: boolean }) {
  const quota = storageQuotaBytes(plan.storageGb);
  const used = plan.usedBytes;
  const share = used === undefined ? 0 : Math.min(1, used / quota);
  const store = plan.storeBytes !== undefined ? { bytes: plan.storeBytes, limit: storeLimitBytes(quota) } : undefined;
  return (
    <>
      {/* No `aria-valuenow` while the figure is unknown: zero would be a figure. */}
      <div className="progress-bar plan-meter" role="meter" aria-valuemin={0} aria-valuemax={quota} {...(used !== undefined ? { 'aria-valuenow': used } : {})} aria-label="Files stored">
        <div className={`progress-fill${share >= FULL_SHARE ? ' plan-meter-full' : ''}`} style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <div className="plan-held">
        <p className="muted small">
          {used !== undefined
            ? `Files: ${formatBytes(used)} of ${plan.storageGb} GB used.`
            : reading
              ? `Reading what is held, of ${plan.storageGb} GB…`
              : `Usage could not be read right now; the plan allows ${plan.storageGb} GB of files.`}
        </p>
        {(store || reading) && (
          <p className="muted small">
            Notes, their history and the text read from files:{' '}
            {store ? (
              <span className={store.bytes / store.limit >= FULL_SHARE ? 'bad' : undefined}>
                {formatBytes(store.bytes)} of {formatBytes(store.limit)} used.
              </span>
            ) : (
              'reading…'
            )}
          </p>
        )}
      </div>
    </>
  );
}
