import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BASE_STORAGE_GB,
  MAX_STORAGE_UNITS,
  PLAN_PRICE_USD,
  STORAGE_ADDON_GB,
  STORAGE_ADDON_PRICE_USD,
  storageQuotaBytes,
  type AccountPlan,
} from '@unbent/shared';
import * as api from '../notes-api.js';
import { errorText } from '../notes-api.js';
import { isHosted } from '../app-bridge.js';
import { formatBytes } from '../format-bytes.js';
import { openCheckout } from '../paddle.js';
import { keys, planUsageQuery } from '../queries.js';
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
  const { billing, plan: standing } = usePlan();
  // This page alone asks the store what the account holds; the banner and the editor
  // read the plan without it. The two answers are the same row, so the one with the
  // figure stands in for the other here once it has arrived.
  const usage = useQuery(planUsageQuery(standing !== undefined));
  const plan = usage.data ?? standing;
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'checkout' | 'portal' | 'storage' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The storage row's own, drawn under it: a refusal there answered under the
  // subscription's heading, a section above, read as about the wrong control.
  const [storageError, setStorageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [units, setUnits] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const hosted = isHosted();

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
        <p className="muted small">Reading your plan…</p>
      </div>
    );
  }

  // The checkout route's line, word for word: only a canceled subscription whose period
  // is over makes way for a new checkout. One still in its paid period, cancelling or
  // not, is managed in the portal; and a past-due one past its paid period is read-only
  // until the card is updated, which is the portal's form too — a new checkout would be
  // a second subscription beside the one Paddle is still trying to collect.
  const subscribed = plan.subscription !== null && !(plan.subscription.status === 'canceled' && plan.state === 'inactive');
  // A comp still running is asked for nothing; one that has ended is a lapsed account
  // like any other, and the checkout is its way back — the operator's "end" and a dated
  // comp running out both leave `source` as it was, so the source alone cannot say.
  const canSubscribe = !hosted && !subscribed && !(plan.source === 'comp' && plan.state !== 'inactive');
  // Storage is changed on a subscription Paddle will bill; a canceled one is refused.
  const canChangeStorage = subscribed && plan.subscription?.status !== 'canceled';
  const chosenUnits = units ?? unitsOf(plan);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.plan() });
  // Less storage than the account holds would refuse every upload after it; the server
  // refuses the change, and the button says why before the press.
  const smaller = storageQuotaBytes(plan.storageGb - STORAGE_ADDON_GB);
  const overSmaller = plan.usedBytes === undefined || plan.usedBytes > smaller;

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
      setError(errorText(err) || 'The checkout could not be opened.');
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
      await api.refreshPlan().catch(() => undefined);
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
        <StorageMeter plan={plan} reading={usage.isPending} />
        {canChangeStorage && !hosted && !adding && (
          <div className="backfill-row">
            {/* Its press opens the confirm, which hides this row while it is open, so the
                confirm's own "Adding…" is the only busy label Add ever needs. */}
            <Button size="small" disabled={busy !== null || unitsOf(plan) >= MAX_STORAGE_UNITS} onClick={() => setAdding(true)}>
              Add {STORAGE_ADDON_GB} GB
            </Button>
            {unitsOf(plan) > 0 && (
              <Button
                size="small"
                variant="quiet"
                disabled={busy !== null || overSmaller}
                tip={
                  plan.usedBytes === undefined
                    ? usage.isPending
                      ? 'Reading what the account holds…'
                      : 'What the account holds could not be read'
                    : overSmaller
                      ? `The account holds more than ${plan.storageGb - STORAGE_ADDON_GB} GB; delete some files first`
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
  // Before the read-only case: a renewal Paddle could not collect leaves the account
  // read-only past its paid period, and the way back is the card, not a new checkout.
  if (sub?.pastDue) {
    const lapsed = plan.state === 'inactive';
    return {
      title: 'Payment failed',
      sentence: own
        ? lapsed
          ? 'The last renewal could not be collected, so the account is read-only. Update the card to edit again; Paddle will try again once it is.'
          : `The last renewal could not be collected. Paddle will try again; update the card to keep the plan${plan.until ? ` past ${formatDay(plan.until)}` : ''}.`
        : lapsed
          ? 'The last renewal could not be collected, and the account is read-only until the card is updated.'
          : `The last renewal could not be collected. Paddle is retrying; the plan lapses${plan.until ? ` past ${formatDay(plan.until)}` : ''} unless the card is updated.`,
    };
  }
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

/** What the account holds against what it may: a bar and the numbers. `reading` while the store has not answered yet. */
function StorageMeter({ plan, reading }: { plan: AccountPlan; reading: boolean }) {
  const quota = storageQuotaBytes(plan.storageGb);
  const used = plan.usedBytes;
  const share = used === undefined ? 0 : Math.min(1, used / quota);
  return (
    <>
      {/* No `aria-valuenow` while the figure is unknown: zero would be a figure. */}
      <div className="progress-bar plan-meter" role="meter" aria-valuemin={0} aria-valuemax={quota} {...(used !== undefined ? { 'aria-valuenow': used } : {})} aria-label="Storage used">
        <div className={`progress-fill${share >= 0.95 ? ' plan-meter-full' : ''}`} style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <p className="muted small">
        {used !== undefined
          ? `${formatBytes(used)} used of ${plan.storageGb} GB.`
          : reading
            ? `Reading what is held, of ${plan.storageGb} GB…`
            : `Usage could not be read right now; the plan allows ${plan.storageGb} GB.`}
      </p>
    </>
  );
}
