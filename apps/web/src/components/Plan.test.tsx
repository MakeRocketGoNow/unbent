import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { AccountPlan } from '@unbent/shared';
import { keys } from '../queries.js';

vi.mock('../app-bridge.js', () => ({ isHosted: vi.fn(() => false) }));
vi.mock('../paddle.js', () => ({ openCheckout: vi.fn() }));
import { isHosted } from '../app-bridge.js';
import { openCheckout } from '../paddle.js';

const { Plan } = await import('./Plan.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/**
 * The page's states and the one control each offers (MAK-108). Seeded rather than
 * fetched, as Maintenance's test is: the config says the instance sells a plan, and the
 * plan is whatever the case needs.
 */
function harness(plan: Partial<AccountPlan>, billing = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), { providers: ['password'], ...(billing ? { billing: { environment: 'sandbox', clientToken: 'test_x' } } : {}) });
  client.setQueryData(keys.plan(), { state: 'trial', until: NOW + 10 * DAY, source: null, storageGb: 10, usedBytes: 0, subscription: null, ...plan });
  const rootRoute = createRootRoute({ component: () => <Plan /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/settings/plan'] }) });
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
});

describe('Plan', () => {
  it('offers a trial the one thing to do, with the storage chosen first', async () => {
    harness({});
    expect(await screen.findByRole('heading', { name: 'Free trial' })).toBeTruthy();
    const subscribe = screen.getByRole('button', { name: 'Subscribe for $36 a year' });
    expect(subscribe.className).toContain('btn-primary');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: 'Subscribe for $60 a year' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage subscription' })).toBeNull();
  });

  it('says read-only, and what still works, once the plan has ended', async () => {
    harness({ state: 'inactive', until: NOW - DAY });
    expect(await screen.findByRole('heading', { name: 'Read-only' })).toBeTruthy();
    expect(screen.getByText(/Everything still opens, searches and exports/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Subscribe/ })).toBeTruthy();
  });

  it('sends a subscribed account to the portal, and sells it storage by the block', async () => {
    harness({ state: 'active', source: 'paddle', until: NOW + 300 * DAY, storageGb: 35, usedBytes: 3 * 1024 ** 3, subscription: { status: 'active', cancelsAt: null, pastDue: false } });
    expect(await screen.findByRole('heading', { name: 'Subscribed' })).toBeTruthy();
    expect(screen.getByText(/Renews on/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Subscribe/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Manage subscription' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add 25 GB' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove 25 GB' })).toBeTruthy();
    expect(screen.getByText('3.00 GB used of 35 GB.')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Storage used' }).getAttribute('aria-valuemax')).toBe(String(35 * 1024 ** 3));
  });

  it('names a cancellation ahead and a failed payment, with the card form for the latter', async () => {
    harness({ state: 'active', source: 'paddle', until: NOW + 30 * DAY, subscription: { status: 'active', cancelsAt: NOW + 30 * DAY, pastDue: false } });
    expect(await screen.findByRole('heading', { name: 'Cancelling' })).toBeTruthy();
    cleanup();
    harness({ state: 'active', source: 'paddle', until: NOW + 3 * DAY, subscription: { status: 'past_due', cancelsAt: null, pastDue: true } });
    expect(await screen.findByRole('heading', { name: 'Payment failed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update payment method' })).toBeTruthy();
  });

  it('asks a comped account for nothing', async () => {
    harness({ state: 'active', source: 'comp', until: null });
    expect(await screen.findByRole('heading', { name: 'Complimentary' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  /** Both stores forbid a web checkout inside the app; the page says where to go instead. */
  it('draws no buttons inside the apps, and says where the plan is managed', async () => {
    vi.mocked(isHosted).mockReturnValue(true);
    harness({});
    expect(await screen.findByRole('heading', { name: 'Free trial' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Subscriptions are managed on the web/)).toBeTruthy();
  });

  it('opens the checkout on the server\'s transaction and re-reads the plan when it completes', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url === '/api/billing/checkout') return Response.json({ transactionId: 'txn_1' });
        if (url === '/api/billing/refresh') return Response.json({ state: 'active' });
        if (url === '/api/me/plan') return Response.json({ state: 'active', until: NOW + 365 * DAY, source: 'paddle', storageGb: 35, subscription: { status: 'active', cancelsAt: null, pastDue: false } });
        return Response.json({}, { status: 404 });
      }),
    );
    vi.mocked(openCheckout).mockResolvedValue('completed');
    harness({});
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe for $48 a year' }));
    expect(await screen.findByRole('heading', { name: 'Subscribed' })).toBeTruthy();
    expect(calls).toContain('POST /api/billing/checkout');
    expect(calls).toContain('POST /api/billing/refresh');
    expect(vi.mocked(openCheckout)).toHaveBeenCalledWith({ environment: 'sandbox', clientToken: 'test_x' }, 'txn_1');
    expect(screen.getByText('You’re subscribed. Thank you.')).toBeTruthy();
  });

  it('is nothing where the instance sells no plan', () => {
    const { container } = harness({}, false);
    expect(container.textContent).toBe('');
  });
});
