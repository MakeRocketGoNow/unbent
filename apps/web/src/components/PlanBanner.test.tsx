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
// The real clock: the hook works the plan out against it too, so an end in the past
// reads as lapsed whatever `now` the banner is handed for its wording.
const NOW = Date.now();

function harness(plan: Partial<AccountPlan> | null, billing = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), { providers: ['password'], ...(billing ? { billing: { environment: 'sandbox', clientToken: 'test_x' } } : {}) });
  if (plan) client.setQueryData(keys.plan(), { state: 'trial', until: NOW + 10 * DAY, source: null, storageGb: 10, subscription: null, ...plan, readOnlyAt: plan.readOnlyAt ?? plan.until ?? NOW + 10 * DAY });
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
    harness({ until: NOW + 60_000 });
    expect(await screen.findByText('Your free trial ends today.')).toBeTruthy();
  });

  it('says read-only, what still works, and the free plan as the other way back, once the plan has ended past it', async () => {
    harness({ state: 'inactive', until: NOW - DAY });
    expect(await screen.findByText("Your notes are read-only until the account is within the free plan's 100 notes and 1 GB. Everything still opens, searches and exports.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Subscribe' })).toBeTruthy();
  });

  it('says nothing on the free plan, which is an account that works', async () => {
    harness({ state: 'free', until: NOW - DAY, readOnlyAt: null });
    expect((await screen.findByRole('status')).textContent).toBe('');
  });

  it('points at the web from inside the apps rather than at a page with no buttons', async () => {
    vi.mocked(isHosted).mockReturnValue(true);
    harness({ state: 'inactive', until: NOW - DAY });
    expect(await screen.findByText('Subscribe on the web.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
