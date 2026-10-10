import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  BASE_STORAGE_GB,
  PLAN_PRICE_USD,
  STORAGE_ADDON_GB,
  STORAGE_ADDON_PRICE_USD,
  storageQuotaBytes,
  type AccountPlan,
  type BillingConfig,
} from '@unbent/shared';
import * as api from '../notes-api.js';
import { isHosted } from '../app-bridge.js';
import { formatBytes } from '../format-bytes.js';
import { openCheckout } from '../paddle.js';
import { keys } from '../queries.js';
import { usePlan } from '../use-plan.js';
import { Button } from './Button.js';
import { Snackbar } from './Snackbar.js';
import { formatDay } from './format-when.js';

/** The most storage blocks the page offers in one go; the API caps the same. */
const MAX_UNITS = 8;

/** How many add-on blocks a quota is, for the storage control. */
function unitsOf(plan: AccountPlan): number {
  return Math.max(0, Math.round((plan.storageGb - BASE_STORAGE_GB) / STORAGE_ADDON_GB));
}

const dollars = (n: number) => `$${n}`;

/**
 * The account's plan (MAK-108): where it stands, what it holds, and the three things
 * that change it — subscribing, managing the subscription in Paddle's portal, and buying
 * more storage. Drawn only where the instance sells a plan (`config.billing`).
 *
 * One state at a time, in a sentence: a trial and when it ends, a subscription and when
 * it renews or cancels, a comp, or read-only and what that still allows. Subscribe is
 * the one `primary` on the page and appears only where it is the thing to do; a
 * subscribed account gets the portal instead, since cancelling and changing the card are
 * Paddle's forms, not this app's.
 *
 * Inside the Android and iOS apps the buttons are not drawn at all. Both stores forbid
 * selling a subscription in an app through anything but their own billing, and a button
 * that opens a web checkout inside the app is the thing a review rejects. The page says
 * where to go instead, and nothing else changes: the plan is the account's, not the
 * device's.
 *
 * The checkout is Paddle's overlay, on a transaction the server made, so the page never
 * learns a price id and the account's Paddle customer exists before the overlay opens.
 * When the overlay reports the payment, the plan is read back from Paddle at once rather
 * than waiting on the webhook: the page should say "Subscribed" when the overlay closes,
 * not a few seconds later.
 */
export function Plan() {
  const { billing, plan } = usePlan();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'checkout' | 'portal' | 'storage' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [units, setUnits] = useState<number | null>(null);
  const hosted = isHosted();

  if (!billing) return null;
  if (!plan) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Plan</h2>
        </div>
        <p className="muted small">Reading your plan…</p>
      </div>
    );
  }

  // A subscription in its paid period, cancelling or not, is managed in the portal; one
  // that has lapsed cannot be revived there, and a new checkout is the way back. The
  // checkout route draws the same line.
  const subscribed = plan.subscription !== null && plan.state !== 'inactive';
  const canSubscribe = !hosted && !subscribed && plan.source !== 'comp';
  const chosenUnits = units ?? unitsOf(plan);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.plan() });

  async function subscribe() {
    setBusy('checkout');
    setError(null);
    try {
      const { transactionId } = await api.startCheckout(chosenUnits);
      const outcome = await openCheckout(billing!, transactionId);
      if (outcome === 'completed') {
        await api.refreshPlan().catch(() => undefined);
        await refresh();
        setNotice('You’re subscribed. Thank you.');
      }
    } catch (err) {
      setError((err as Error).message || 'The checkout could not be opened.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * The portal opens in a new tab, which has to be opened before the link is fetched:
   * a `window.open` after an `await` is a pop-up to the browser, and blocked. So the tab
   * is opened blank on the press and pointed at the link when it arrives; a browser that
   * refused even that is sent there in this tab instead.
   *
   * What was done there is read back when this tab is next looked at: a cancellation or
   * a new card is Paddle's news, and the webhook may or may not have landed by then, so
   * the subscription is read from Paddle rather than the row (`refreshPlan`). Once, on
   * the first return, since the listener is removed as it fires.
   */
  async function openPortal(which: 'overview' | 'payment') {
    setBusy('portal');
    setError(null);
    const tab = window.open('', '_blank');
    try {
      const links = await api.portalLinks();
      const url = (which === 'payment' && links.payment) || links.overview;
      if (tab) tab.location.href = url;
      else window.location.href = url;
      const onReturn = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', onReturn);
        void api.refreshPlan().catch(() => undefined).then(refresh);
      };
      document.addEventListener('visibilitychange', onReturn);
    } catch (err) {
      tab?.close();
      setError((err as Error).message || 'The portal could not be opened.');
    } finally {
      setBusy(null);
    }
  }

  async function changeStorage(next: number) {
    setBusy('storage');
    setError(null);
    try {
      await api.setStorage(next);
      await api.refreshPlan().catch(() => undefined);
      await refresh();
      setNotice(next > unitsOf(plan!) ? `Added ${STORAGE_ADDON_GB} GB.` : `Removed ${STORAGE_ADDON_GB} GB.`);
    } catch (err) {
      setError((err as Error).message || 'The storage could not be changed.');
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
        One plan, {dollars(PLAN_PRICE_USD)} a year: unlimited notes, {BASE_STORAGE_GB} GB of files, and{' '}
        {STORAGE_ADDON_GB} GB more for {dollars(STORAGE_ADDON_PRICE_USD)} a year each. If it ends,
        your notes stay readable and exportable.
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
                {busy === 'checkout' ? 'Opening checkout…' : `Subscribe for ${dollars(PLAN_PRICE_USD + chosenUnits * STORAGE_ADDON_PRICE_USD)} a year`}
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
            <span className="muted small">Invoices, the card, and cancelling, in Paddle’s portal.</span>
          </div>
        )}
        {error && <p className="bad small">{error}</p>}
      </section>

      <section className="settings-section">
        <h3>Storage</h3>
        <StorageMeter plan={plan} />
        {subscribed && !hosted && (
          <div className="backfill-row">
            <Button size="small" disabled={busy !== null || unitsOf(plan) >= MAX_UNITS} onClick={() => void changeStorage(unitsOf(plan) + 1)}>
              {busy === 'storage' ? 'Changing…' : `Add ${STORAGE_ADDON_GB} GB`}
            </Button>
            {unitsOf(plan) > 0 && (
              <Button size="small" variant="quiet" disabled={busy !== null} onClick={() => void changeStorage(unitsOf(plan) - 1)}>
                Remove {STORAGE_ADDON_GB} GB
              </Button>
            )}
            <span className="muted small">
              {dollars(STORAGE_ADDON_PRICE_USD)} a year per {STORAGE_ADDON_GB} GB, charged for the rest of this year now.
            </span>
          </div>
        )}
      </section>

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
  if (plan.state === 'inactive') {
    const ended = plan.until ? `ended on ${formatDay(plan.until)}` : 'has ended';
    return {
      title: 'Read-only',
      sentence: own
        ? `Your plan ${ended}. Everything still opens, searches and exports, and anything can be deleted; subscribe to edit again.`
        : `Their plan ${ended}. Everything still opens and exports; nothing can be edited until they subscribe or are comped.`,
    };
  }
  if (plan.state === 'trial') {
    const ends = plan.until ? `ends on ${formatDay(plan.until)}` : 'is under way';
    return {
      title: 'Free trial',
      sentence: own ? `Your trial ${ends}. Nothing is charged until you subscribe.` : `Their trial ${ends}.`,
    };
  }
  if (plan.source === 'comp') {
    const until = plan.until ? `until ${formatDay(plan.until)}` : 'with no end date';
    return { title: 'Complimentary', sentence: `${own ? 'This account' : 'The account'} is on the house, ${until}.` };
  }
  if (sub?.pastDue) {
    const past = plan.until ? ` past ${formatDay(plan.until)}` : '';
    return {
      title: 'Payment failed',
      sentence: own
        ? `The last renewal could not be collected. Paddle will try again; update the card to keep the plan${past}.`
        : `The last renewal could not be collected. Paddle is retrying; the plan lapses${past} unless the card is updated.`,
    };
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

/** What the account holds against what it may: a bar and the numbers. */
function StorageMeter({ plan }: { plan: AccountPlan }) {
  const quota = storageQuotaBytes(plan.storageGb);
  const used = plan.usedBytes;
  const share = used === undefined ? 0 : Math.min(1, used / quota);
  return (
    <>
      <div className="progress-bar plan-meter" role="meter" aria-valuemin={0} aria-valuemax={quota} aria-valuenow={used ?? 0} aria-label="Storage used">
        <div className={`progress-fill${share >= 0.95 ? ' plan-meter-full' : ''}`} style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <p className="muted small">
        {used === undefined ? 'Usage could not be read right now' : `${formatBytes(used)} used`} of {plan.storageGb} GB.
      </p>
    </>
  );
}
