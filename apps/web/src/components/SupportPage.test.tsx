import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { REFUND_DAYS } from '@unbent/shared';
import { keys } from '../queries.js';

const useSession = vi.fn();
vi.mock('../auth-client.js', () => ({ useSession: () => useSession() }));

const { SupportPage, SUPPORT_META } = await import('./SupportPage.js');

/** The config seeded as `WhyPage.test` seeds it: the page and the footer read it, and jsdom has no server. */
function harness(operator: { name: string; email: string; host: string } | null) {
  useSession.mockReturnValue({ data: null, isPending: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), {
    providers: [],
    frontPage: true,
    legal: { privacy: '/privacy', terms: '/terms' },
    operator,
  });
  const rootRoute = createRootRoute({ component: SupportPage });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/support'] }),
  });
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

describe('SupportPage', () => {
  afterEach(() => {
    cleanup();
    useSession.mockReset();
  });

  it("names the operator's address first, and sends each question where it is handled", async () => {
    const { findByRole, getByText, getByRole, container } = harness({
      name: 'Example Co',
      email: 'help@example.com',
      host: 'notes.example.com',
    });
    expect(await findByRole('heading', { name: 'Support' })).toBeTruthy();
    expect(document.title).toBe(SUPPORT_META.title);
    // The address is a link in the lead, before any of the topics.
    expect(getByRole('link', { name: 'help@example.com' }).getAttribute('href')).toBe('mailto:help@example.com');
    // The refund policy's own anchor in the terms, with the days the terms state.
    expect(getByText('refund policy').getAttribute('href')).toBe('/terms#refunds');
    expect(container.textContent).toContain(`within ${REFUND_DAYS} days`);
    // The app's own pages for what the app does itself.
    expect(getByText('Settings, then Plan').getAttribute('href')).toBe('/settings/plan');
    expect(getByText('Settings, then Export').getAttribute('href')).toBe('/settings/export');
    expect(getByText('Deleting your Unbent account').getAttribute('href')).toBe('/delete-my-account');
    // Bugs and vulnerabilities go to the repository, by two different doors.
    expect(getByText('Report a bug or suggest a feature on GitHub').getAttribute('href')).toMatch(
      /\/issues\/new\/choose$/,
    );
    expect(getByText("GitHub's private vulnerability reporting").getAttribute('href')).toMatch(
      /\/security\/advisories\/new$/,
    );
    // Nothing on it is a button: every control navigates.
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  /** A fork that named no operator still gets the page, without an address it does not have. */
  it('keeps the topics and drops the address when the instance names no operator', async () => {
    const { findByRole, queryByRole, container } = harness(null);
    await findByRole('heading', { name: 'Support' });
    expect(queryByRole('link', { name: /@/ })).toBeNull();
    expect(container.textContent).not.toContain('mailto');
    expect(await findByRole('heading', { name: 'Signing in' })).toBeTruthy();
  });

  it('hands the title back when the page is left', async () => {
    const { findByRole, unmount } = harness(null);
    await findByRole('heading', { name: 'Support' });
    unmount();
    expect(document.title).toBe('Unbent');
  });
});
