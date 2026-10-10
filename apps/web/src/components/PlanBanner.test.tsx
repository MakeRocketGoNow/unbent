import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { AccountPlan } from '@unbent/shared';
import { keys } from '../queries.js';

vi.mock('../app-bridge.js', () => ({ isHosted: vi.fn(() => false) }));
import { isHosted } from '../app-bridge.js';

const { PlanBanner } = await import('./PlanBanner.js');

const DAY = 24 * 60 * 60 * 1000;
// Local noon, so a day either side is the day either side in whatever zone runs this.
const NOW = new Date(2026, 9, 10, 12).getTime();

function harness(plan: Partial<AccountPlan> | null, billing = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), { providers: ['password'], ...(billing ? { billing: { environment: 'sandbox', clientToken: 'test_x' } } : {}) });
  if (plan) client.setQueryData(keys.plan(), { state: 'trial', until: NOW + 10 * DAY, source: null, storageGb: 10, subscription: null, ...plan });
  const rootRoute = createRootRoute({ component: () => <PlanBanner now={NOW} /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/notes'] }) });
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
});

describe('PlanBanner', () => {
  it('says nothing for most of a trial, and nothing at all where there is no plan', async () => {
    harness({ until: NOW + 10 * DAY });
    await screen.findByRole('status');
    expect(screen.queryByText(/trial/)).toBeNull();
    cleanup();
    harness(null, false);
    await screen.findByRole('status');
    expect(screen.queryByText(/plan/)).toBeNull();
  });

  it('counts down the last days of a trial', async () => {
    harness({ until: NOW + 2 * DAY });
    expect(await screen.findByText('Your free trial ends in 2 days.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Subscribe' }).getAttribute('href')).toBe('/settings/plan');
    cleanup();
    harness({ until: NOW + DAY - 1 });
    expect(await screen.findByText('Your free trial ends tomorrow.')).toBeTruthy();
    cleanup();
    harness({ until: NOW + 1000 });
    expect(await screen.findByText('Your free trial ends today.')).toBeTruthy();
  });

  it('says read-only, and what still works, once the plan has ended', async () => {
    harness({ state: 'inactive', until: NOW - DAY });
    expect(await screen.findByText(/read-only\. Everything still opens, searches and exports/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Subscribe' })).toBeTruthy();
  });

  it('points at the web from inside the apps rather than at a page with no buttons', async () => {
    vi.mocked(isHosted).mockReturnValue(true);
    harness({ state: 'inactive', until: NOW - DAY });
    expect(await screen.findByText('Subscribe on the web.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
