import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { AccountPlan } from '@unbent/shared';
import { keys } from '../queries.js';

vi.mock('../app-bridge.js', () => ({ isHosted: vi.fn(() => false) }));
import { isHosted } from '../app-bridge.js';

const { Plan, leavePage } = await import('./Plan.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/**
 * The page's states and the one control each offers (MAK-108). Seeded rather than
 * fetched, as Maintenance's test is: the config says the instance sells a plan, and the
 * plan is whatever the case needs.
 */
function harness(plan: Partial<AccountPlan>, billing = true, entry = '/settings/plan') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), { providers: ['password'], ...(billing ? { billing: { environment: 'test' } } : {}) });
  client.setQueryData(keys.plan(), { state: 'trial', until: NOW + 10 * DAY, source: null, storageGb: 10, usedBytes: 0, subscription: null, ...plan, readOnlyAt: plan.readOnlyAt ?? plan.until ?? NOW + 10 * DAY });
  const rootRoute = createRootRoute({ component: () => <Plan /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: [entry] }) });
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(isHosted).mockReturnValue(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Plan', () => {
  it('offers a trial the one thing to do, with the storage chosen first', async () => {
    harness({});
    expect(await screen.findByRole('heading', { name: 'Free trial' })).toBeTruthy();
    const subscribe = screen.getByRole('button', { name: 'Subscribe for $60 a year' });
    expect(subscribe.className).toContain('btn-primary');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: 'Subscribe for $84 a year' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage subscription' })).toBeNull();
  });

  it('says read-only, and what still works, once the plan has ended', async () => {
    harness({ state: 'inactive', until: NOW - DAY });
    expect(await screen.findByRole('heading', { name: 'Read-only' })).toBeTruthy();
    expect(screen.getByText(/Everything still opens, searches and exports/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Subscribe/ })).toBeTruthy();
  });

  it('sends a subscribed account to the portal, and sells it storage by the block', async () => {
    harness({ state: 'active', source: 'stripe', until: NOW + 300 * DAY, storageGb: 35, usedBytes: 3 * 1024 ** 3, subscription: { status: 'active', cancelsAt: null, pastDue: false } });
    expect(await screen.findByRole('heading', { name: 'Subscribed' })).toBeTruthy();
    expect(screen.getByText(/Renews on/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Subscribe/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Manage subscription' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add 25 GB' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove 25 GB' })).toBeTruthy();
    expect(screen.getByText('Files: 3.00 GB of 35 GB used.')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Files stored' }).getAttribute('aria-valuemax')).toBe(String(35 * 1024 ** 3));
  });

  /**
   * The store has a bound of its own (MAK-234), and a note write past it sends people
   * here: the page says where the store stands beside the files, named for what counts
   * in it, and marks a store that is all but full as the bar marks the files.
   */
  it('shows how much room the notes take against the store limit, beside the files', async () => {
    const MB = 1024 ** 2;
    harness({ state: 'active', source: 'stripe', until: NOW + 300 * DAY, storageGb: 10, usedBytes: 2 * 1024 ** 3, storeBytes: 180 * MB, subscription: { status: 'active', cancelsAt: null, pastDue: false } });
    expect(await screen.findByText('Files: 2.00 GB of 10 GB used.')).toBeTruthy();
    const store = screen.getByText(/Notes, their history and the text read from files:/);
    expect(store.textContent).toBe('Notes, their history and the text read from files: 180.0 MB of 1.50 GB used.');
    expect(store.querySelector('.bad')).toBeNull();
    cleanup();
    harness({ state: 'active', source: 'stripe', until: NOW + 300 * DAY, storageGb: 10, usedBytes: 2 * 1024 ** 3, storeBytes: 1500 * MB, subscription: { status: 'active', cancelsAt: null, pastDue: false } });
    const full = await screen.findByText(/Notes, their history and the text read from files:/);
    expect(full.querySelector('.bad')?.textContent).toBe('1.46 GB of 1.50 GB used.');
    // While the store has not answered (the harness never answers the usage read), the
    // line holds its place with no figure, so the buttons under it do not move when
    // the figure arrives.
    cleanup();
    harness({ state: 'active', source: 'stripe', until: NOW + 300 * DAY, storageGb: 10, usedBytes: 2 * 1024 ** 3, subscription: { status: 'active', cancelsAt: null, pastDue: false } });
    expect(await screen.findByText('Files: 2.00 GB of 10 GB used.')).toBeTruthy();
    expect(screen.getByText(/Notes, their history/).textContent).toBe('Notes, their history and the text read from files: reading…');
  });

  /**
   * A block is store room too (a tenth of itself, `storeLimitBytes`), so a store that
   * would be over the smaller limit disables Remove as files over the smaller quota do,
   * with the reason read out, before the server refuses the same.
   */
  it('refuses to remove a block while the notes would be over the smaller store limit', async () => {
    const GB = 1024 ** 3;
    harness({ state: 'active', source: 'stripe', until: NOW + 300 * DAY, storageGb: 35, usedBytes: 2 * GB, storeBytes: 3 * GB, subscription: { status: 'active', cancelsAt: null, pastDue: false } });
    const remove = await screen.findByRole('button', { name: 'Remove 25 GB' });
    expect(remove.hasAttribute('disabled')).toBe(true);
    expect(remove.getAttribute('aria-description')).toBe('The notes take more than the 1.50 GB of room they would have; delete some notes or clear their history, and empty the trash, first');
    // Under the smaller limit, the block can go.
    cleanup();
    harness({ state: 'active', source: 'stripe', until: NOW + 300 * DAY, storageGb: 35, usedBytes: 2 * GB, storeBytes: GB, subscription: { status: 'active', cancelsAt: null, pastDue: false } });
    const ok = await screen.findByRole('button', { name: 'Remove 25 GB' });
    expect(ok.hasAttribute('disabled')).toBe(false);
    expect(ok.getAttribute('aria-description')).toBeNull();
  });

  it('names a cancellation ahead and a failed payment, with the card form for the latter', async () => {
    harness({ state: 'active', source: 'stripe', until: NOW + 30 * DAY, subscription: { status: 'active', cancelsAt: NOW + 30 * DAY, pastDue: false } });
    expect(await screen.findByRole('heading', { name: 'Cancelling' })).toBeTruthy();
    cleanup();
    harness({ state: 'active', source: 'stripe', until: NOW + 3 * DAY, subscription: { status: 'past_due', cancelsAt: null, pastDue: true } });
    expect(await screen.findByRole('heading', { name: 'Payment failed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update payment method' })).toBeTruthy();
  });

  /** Past its paid period, a past-due account is read-only, and the card is the way back, never a second checkout. */
  it('sends a past-due account past its paid period to the card form, not to a checkout', async () => {
    harness({ state: 'inactive', source: 'stripe', until: NOW - DAY, subscription: { status: 'past_due', cancelsAt: null, pastDue: true } });
    expect(await screen.findByRole('heading', { name: 'Payment failed' })).toBeTruthy();
    expect(screen.getByText(/read-only. Update the card/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Subscribe/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Update payment method' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage subscription' })).toBeTruthy();
    // And a canceled subscription whose period is over is offered the checkout, with no storage to change.
    cleanup();
    harness({ state: 'inactive', source: 'stripe', until: NOW - DAY, subscription: { status: 'canceled', cancelsAt: null, pastDue: false } });
    expect(await screen.findByRole('button', { name: /^Subscribe/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add 25 GB' })).toBeNull();
  });

  it('asks a comped account for nothing', async () => {
    harness({ state: 'active', source: 'comp', until: null });
    expect(await screen.findByRole('heading', { name: 'Complimentary' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers a comp that has ended the checkout, as any lapsed account', async () => {
    harness({ state: 'inactive', source: 'comp', until: NOW - DAY });
    expect(await screen.findByRole('heading', { name: 'Read-only' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Subscribe/ })).toBeTruthy();
  });

  /** Both stores forbid a web checkout inside the app; the page says where to go instead. */
  it('draws no buttons inside the apps, and says where the plan is managed', async () => {
    vi.mocked(isHosted).mockReturnValue(true);
    harness({});
    expect(await screen.findByRole('heading', { name: 'Free trial' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Subscriptions are managed on the web/)).toBeTruthy();
  });

  it('sends the browser to Stripe\'s checkout for the storage chosen, and stays busy until it has left', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/billing/checkout') {
          bodies.push(String(init?.body));
          return Response.json({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
        }
        return Response.json({}, { status: 404 });
      }),
    );
    const leave = vi.spyOn(leavePage, 'to').mockImplementation(() => {});
    harness({});
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe for $72 a year' }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1'));
    expect(bodies).toEqual(['{"storage":1}']);
    // Still "Opening checkout…": the page is on its way out, and a second press would be a second session.
    expect(screen.getByRole('button', { name: 'Opening checkout…' })).toBeTruthy();
  });

  it('says the checkout could not be opened when the server refuses, and offers the button again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Stripe could not start the checkout right now. Try again shortly.' }, { status: 502 })));
    const leave = vi.spyOn(leavePage, 'to').mockImplementation(() => {});
    harness({});
    fireEvent.click(await screen.findByRole('button', { name: 'Subscribe for $60 a year' }));
    expect(await screen.findByText('Stripe could not start the checkout right now. Try again shortly.')).toBeTruthy();
    expect(leave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Subscribe for $60 a year' })).toBeTruthy();
  });

  /** Stripe sends the person back with `?checkout=complete`; the page reads the plan back until it names the subscription. */
  it('re-reads the plan on return from a paid checkout, and takes the query off the address', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        // The first read is a moment too early for the subscription; the second has it.
        if (url === '/api/billing/refresh') return Response.json(calls.filter((c) => c.endsWith('/refresh')).length > 1 ? { state: 'active', subscription: { status: 'active', cancelsAt: null, pastDue: false } } : { state: 'trial', subscription: null });
        if (url === '/api/me/plan') return Response.json({ state: 'active', until: NOW + 365 * DAY, readOnlyAt: NOW + 366 * DAY, source: 'stripe', storageGb: 35, subscription: { status: 'active', cancelsAt: null, pastDue: false } });
        return Response.json({}, { status: 404 });
      }),
    );
    harness({}, true, '/settings/plan?checkout=complete');
    // The wait says what it is waiting for, not that a checkout is opening.
    expect(await screen.findByRole('button', { name: 'Confirming your subscription…' })).toBeTruthy();
    // The second read comes after `settleCheckout`'s wait, past the finder's default second.
    expect(await screen.findByRole('heading', { name: 'Subscribed' }, { timeout: 4000 })).toBeTruthy();
    expect(calls.filter((c) => c === 'POST /api/billing/refresh')).toHaveLength(2);
    expect(screen.getByText('You’re subscribed. Thank you.')).toBeTruthy();
  });

  /** The address can be typed or bookmarked, so it alone is no reason to say thank you. */
  it('does not thank anyone for a subscription the read-back never found', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/billing/refresh') return Response.json({ state: 'trial', subscription: null });
        if (url === '/api/me/plan') return Response.json({ state: 'trial', until: NOW + 10 * DAY, readOnlyAt: NOW + 10 * DAY, source: null, storageGb: 10, subscription: null });
        return Response.json({}, { status: 404 });
      }),
    );
    try {
      harness({}, true, '/settings/plan?checkout=complete');
      await screen.findByRole('button', { name: 'Confirming your subscription…' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await screen.findByText('Your plan will update once Stripe confirms the payment.')).toBeTruthy();
      expect(screen.queryByText('You’re subscribed. Thank you.')).toBeNull();
      expect(screen.getByRole('button', { name: 'Subscribe for $60 a year' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so, with a way to try again, when the plan cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'down' }, { status: 503 })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.config(), { providers: ['password'], billing: { environment: 'test' } });
    const rootRoute = createRootRoute({ component: () => <Plan /> });
    const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/settings/plan'] }) });
    render(
      <QueryClientProvider client={client}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Your plan could not be read right now.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  /** The returning subscriber's row names the old, canceled subscription, which the first read-back still finds. */
  it('keeps reading the plan back after a lapsed subscriber\'s checkout until the new subscription is there', async () => {
    const refreshes: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/billing/refresh') {
          refreshes.push(1);
          return Response.json(refreshes.length > 1 ? { state: 'active', subscription: { status: 'active', cancelsAt: null, pastDue: false } } : { state: 'inactive', subscription: { status: 'canceled', cancelsAt: null, pastDue: false } });
        }
        if (url === '/api/me/plan') return Response.json({ state: 'active', until: NOW + 365 * DAY, readOnlyAt: NOW + 366 * DAY, source: 'stripe', storageGb: 10, subscription: { status: 'active', cancelsAt: null, pastDue: false } });
        return Response.json({}, { status: 404 });
      }),
    );
    harness({ state: 'inactive', until: NOW - DAY, source: 'stripe', subscription: { status: 'canceled', cancelsAt: null, pastDue: false } }, true, '/settings/plan?checkout=complete');
    expect(await screen.findByRole('heading', { name: 'Subscribed' }, { timeout: 4000 })).toBeTruthy();
    expect(refreshes).toHaveLength(2);
  });

  it('is nothing where the instance sells no plan', () => {
    const { container } = harness({}, false);
    expect(container.textContent).toBe('');
  });
});
