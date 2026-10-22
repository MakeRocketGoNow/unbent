import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { PLAN_PRICE_USD, STORAGE_ADDON_PRICE_USD } from '@unbent/shared';
import { keys } from '../queries.js';

const useSession = vi.fn();
vi.mock('../auth-client.js', () => ({ useSession: () => useSession() }));

const { PricingPage } = await import('./PricingPage.js');

/**
 * The page a merchant of record's review reads and a signed-in person may open: it states both prices,
 * and the way out matches who is reading. The config is seeded, as `LegalPage.test` seeds
 * it, since the footer reads it and jsdom has no server.
 */
function harness(session: { user: { id: string } } | null) {
  useSession.mockReturnValue({ data: session, isPending: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), {
    providers: [],
    frontPage: true,
    legal: { privacy: '/privacy', terms: '/terms' },
    operator: { name: 'Example Co', email: 'help@example.com', host: 'notes.example.com' },
  });
  const rootRoute = createRootRoute({ component: PricingPage });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/pricing'] }),
  });
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

describe('PricingPage', () => {
  afterEach(() => {
    cleanup();
    useSession.mockReset();
  });

  it('states the plan and the add-on prices, and offers the trial to someone signed out', async () => {
    const { findByRole, getByText } = harness(null);
    expect(await findByRole('heading', { name: 'Pricing' })).toBeTruthy();
    expect(getByText(`$${PLAN_PRICE_USD}`)).toBeTruthy();
    expect(getByText(new RegExp(`\\$${STORAGE_ADDON_PRICE_USD} a year`))).toBeTruthy();
    expect(getByText('Start your free trial').getAttribute('href')).toBe('/login');
    expect(getByText('Sign in').getAttribute('href')).toBe('/login');
  });

  /** A signed-in person asked for the page and gets it, with their notes as the way out. */
  it('shows the same prices to someone signed in, with their notes as the way out', async () => {
    const { findByRole, getByText, queryByText } = harness({ user: { id: 'u1' } });
    expect(await findByRole('heading', { name: 'Pricing' })).toBeTruthy();
    expect(getByText(`$${PLAN_PRICE_USD}`)).toBeTruthy();
    expect(getByText('Open your notes').getAttribute('href')).toBe('/notes');
    expect(getByText('Your notes').getAttribute('href')).toBe('/notes');
    expect(queryByText('Start your free trial')).toBeNull();
    expect(queryByText('Sign in')).toBeNull();
  });
});
