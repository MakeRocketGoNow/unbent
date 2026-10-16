import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { AppConfig } from '@unbent/shared';
import { keys } from '../queries.js';
import { LegalPage, type LegalWhich } from './LegalPage.js';

const OPERATOR = {
  name: 'Example Co',
  email: 'help@example.com',
  host: 'notes.example.com',
};
const BUILT_IN = { privacy: '/privacy', terms: '/terms' };
const ELSEWHERE = { privacy: 'https://example.com/privacy', terms: 'https://example.com/terms' };

/**
 * The three states a legal page can be in, each of which somebody can arrive at from a
 * store listing, so what is pinned here is that none of them is blank or an error.
 */
function harness(which: LegalWhich, config: Partial<AppConfig>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seeded rather than fetched: jsdom has no server, and this is the only query it reads.
  client.setQueryData(keys.config(), { providers: ['password'], ...config });

  const rootRoute = createRootRoute({ component: () => <LegalPage which={which} /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/privacy'] }),
  });
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

describe('LegalPage', () => {
  afterEach(cleanup);

  it('renders the built-in policy for the operator who runs this instance', async () => {
    const { findByText } = harness('privacy', { operator: OPERATOR, legal: BUILT_IN });
    expect(await findByText(/Example Co/)).toBeTruthy();
  });

  it('renders the deletion page Play links to', async () => {
    const { findByRole } = harness('deletion', { operator: OPERATOR, legal: BUILT_IN });
    expect(await findByRole('heading', { name: 'Deleting your Unbent account' })).toBeTruthy();
  });

  /*
   * The state a fresh checkout is in. A blank page or a 404 would read as a broken app
   * rather than an unconfigured one, and this page is reachable from a store listing.
   */
  it('says so where the instance publishes nothing', async () => {
    const { findByText, queryByText } = harness('privacy', {});
    expect(await findByText(/has not published a privacy policy/)).toBeTruthy();
    expect(queryByText(/Effective/)).toBeNull();
  });

  it('points at the operator’s own documents when they host them', async () => {
    const { findByText } = harness('privacy', { legal: ELSEWHERE });
    const link = await findByText('https://example.com/privacy');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://example.com/privacy');
  });

  /* One noun for both sentences produced "Its a privacy policy is at", and terms are
     plural besides. The wording is pinned because nothing else would catch it. */
  it('says where the documents are in a sentence that reads', async () => {
    const { findByText } = harness('privacy', { legal: ELSEWHERE });
    expect(await findByText(/^The privacy policy is at/)).toBeTruthy();

    cleanup();
    const terms = harness('terms', { legal: ELSEWHERE });
    expect(await terms.findByText(/^The terms are at/)).toBeTruthy();
  });

  /** Terms link to the terms, not to the policy that happens to be beside them. */
  it('points the terms page at the external terms', async () => {
    const { findByText } = harness('terms', { legal: ELSEWHERE });
    expect((await findByText('https://example.com/terms')).getAttribute('href')).toBe(
      'https://example.com/terms',
    );
  });

  it('describes error tracking only where the instance reports to it', async () => {
    const { findAllByText } = harness('privacy', {
      operator: OPERATOR,
      legal: BUILT_IN,
      posthog: { key: 'phc_x', uiHost: 'https://us.posthog.com' },
    });
    // Twice over: the paragraph saying what is collected, and the list of who touches it.
    expect(await findAllByText(/error-tracking service/)).toHaveLength(2);
  });

  it('leaves it out where the instance only logs errors itself', async () => {
    const { findByText, queryByText } = harness('privacy', {
      operator: OPERATOR,
      legal: BUILT_IN,
    });
    await findByText(/Example Co/);
    expect(queryByText(/error-tracking/)).toBeNull();
  });

  /*
   * The payment terms follow `legal.sellsPlan`, which the server sets for billing or a
   * front page. The front-page-only case is the one Paddle's review reads before billing
   * is on, so it is the one pinned.
   */
  it('publishes the refund policy only where the server says it sells a plan', async () => {
    const { findByRole } = harness('terms', {
      operator: OPERATOR,
      legal: { ...BUILT_IN, sellsPlan: true },
    });
    expect(await findByRole('heading', { name: 'Refunds' })).toBeTruthy();

    cleanup();
    const plain = harness('terms', { operator: OPERATOR, legal: BUILT_IN, frontPage: true });
    await plain.findByRole('heading', { name: 'Terms of Service' });
    expect(plain.queryByRole('heading', { name: 'Refunds' })).toBeNull();
  });

  /** The backups' paragraphs follow `config.backups`, the way error tracking follows `posthog`. */
  it('describes the backups only where the instance keeps them', async () => {
    const { findByText } = harness('deletion', {
      operator: OPERATOR,
      legal: BUILT_IN,
      backups: true,
    });
    expect(await findByText(/gone within about three months of the deletion/)).toBeTruthy();

    cleanup();
    const plain = harness('deletion', { operator: OPERATOR, legal: BUILT_IN });
    expect(await plain.findByText(/Nothing else of your account or its contents is kept/)).toBeTruthy();
  });

  it('offers a way back into the app from every state', async () => {
    const { findByText } = harness('terms', {});
    expect((await findByText('Back to Unbent')).getAttribute('href')).toBe('/');
  });
});
