import type { BillingConfig } from '@unbent/shared';

/**
 * Paddle.js, loaded when a checkout is about to open and not before (MAK-108).
 *
 * The script is Paddle's own, from its CDN, and it is what draws the checkout overlay:
 * the card form is Paddle's page in an iframe, which is the point of a merchant of record:
 * no card number ever reaches this app. It is a third party on the page all the same,
 * so it is fetched on the Subscribe press rather than at start-up, the way the error
 * tracker is loaded only where it is configured (`posthog.ts`): someone who never opens
 * the Plan page never loads it, and a self-hosted instance with billing off never could.
 *
 * Not the npm package: it is a loader for this same script with types on top, and a
 * dependency for a script tag is one more thing to hold back (DEPENDENCIES.md).
 *
 * One load and one `Initialize` per page (Paddle.js refuses a second), with the
 * checkout's events fanned out to whoever is waiting on them.
 */

const SCRIPT_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';

interface CheckoutEvent {
  name: string;
  data?: { transaction_id?: string };
}

interface PaddleJs {
  Environment: { set(env: 'sandbox' | 'production'): void };
  Initialize(options: { token: string; eventCallback?: (event: CheckoutEvent) => void }): void;
  Checkout: { open(options: { transactionId: string }): void; close(): void };
}

declare global {
  interface Window {
    Paddle?: PaddleJs;
  }
}

const listeners = new Set<(event: CheckoutEvent) => void>();
let loading: Promise<PaddleJs> | null = null;

function loadScript(): Promise<PaddleJs> {
  if (window.Paddle) return Promise.resolve(window.Paddle);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.Paddle ? resolve(window.Paddle) : reject(new Error('Paddle.js loaded but left nothing on the page')));
    script.onerror = () => reject(new Error('Paddle.js could not be loaded. Check the connection, or a content blocker.'));
    document.head.appendChild(script);
  });
}

/** Paddle.js, loaded and initialised for this instance's environment. Idempotent. */
export function loadPaddle(billing: BillingConfig): Promise<PaddleJs> {
  if (!loading) {
    loading = loadScript().then((paddle) => {
      if (billing.environment === 'sandbox') paddle.Environment.set('sandbox');
      paddle.Initialize({
        token: billing.clientToken,
        eventCallback: (event) => {
          for (const listener of listeners) listener(event);
        },
      });
      return paddle;
    });
    // A failed load is not final: the next press tries again.
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

export type CheckoutOutcome = 'completed' | 'closed';

/**
 * Opens the overlay on a transaction the server made, and settles when the person is done
 * with it: `completed` once Paddle says the payment went through, `closed` if they close
 * the overlay first. Paddle sends `checkout.closed` after `checkout.completed` too, so
 * the first of the two to arrive is the answer.
 */
export function openCheckout(billing: BillingConfig, transactionId: string): Promise<CheckoutOutcome> {
  return loadPaddle(billing).then(
    (paddle) =>
      new Promise<CheckoutOutcome>((resolve) => {
        const listener = (event: CheckoutEvent) => {
          if (event.name === 'checkout.completed') settle('completed');
          else if (event.name === 'checkout.closed') settle('closed');
        };
        const settle = (outcome: CheckoutOutcome) => {
          listeners.delete(listener);
          resolve(outcome);
        };
        listeners.add(listener);
        paddle.Checkout.open({ transactionId });
      }),
  );
}
