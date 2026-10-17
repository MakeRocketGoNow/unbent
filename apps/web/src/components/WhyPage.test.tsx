import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { keys } from '../queries.js';

const useSession = vi.fn();
vi.mock('../auth-client.js', () => ({ useSession: () => useSession() }));

const { WhyPage, WHY_META } = await import('./WhyPage.js');

/** The config seeded as `PricingPage.test` seeds it: the footer reads it and jsdom has no server. */
function harness(session: { user: { id: string } } | null) {
  useSession.mockReturnValue({ data: session, isPending: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), {
    providers: [],
    frontPage: true,
    legal: { privacy: '/privacy', terms: '/terms' },
    operator: { name: 'Example Co', email: 'help@example.com', host: 'notes.example.com' },
  });
  const rootRoute = createRootRoute({ component: WhyPage });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/why'] }),
  });
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

describe('WhyPage', () => {
  afterEach(() => {
    cleanup();
    useSession.mockReset();
  });

  it('tells the story under its own title, with the trial as the one filled control', async () => {
    const { findByRole, getByText, container } = harness(null);
    expect(await findByRole('heading', { name: 'Why Unbent exists' })).toBeTruthy();
    expect(document.title).toBe(WHY_META.title);
    expect(document.head.querySelector<HTMLMetaElement>('meta[name="description"]')?.content).toBe(WHY_META.description);
    expect(getByText('Start your free trial').getAttribute('href')).toBe('/login');
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);
    // The words a search for this page types, present as plain words.
    expect(container.textContent).toMatch(/Evernote alternative/);
    expect(container.textContent).toMatch(/export Evernote to Markdown/);
    expect(container.textContent).toMatch(/held hostage/);
  });

  /** The public record is dated, and each date is its source. */
  it('links every dated fact to where it was reported', async () => {
    const { findByRole, container } = harness(null);
    await findByRole('heading', { name: 'What changed' });
    const sources = [...container.querySelectorAll<HTMLAnchorElement>('.front-story a[rel="noopener noreferrer"]')];
    expect(sources.length).toBeGreaterThanOrEqual(4);
    for (const a of sources) expect(a.href).toMatch(/^https:\/\//);
  });

  it('gives someone signed in their notes as the way out, and no trial', async () => {
    const { findByRole, getByText, queryByText } = harness({ user: { id: 'u1' } });
    await findByRole('heading', { name: 'Why Unbent exists' });
    expect(getByText('Open your notes').getAttribute('href')).toBe('/notes');
    expect(queryByText('Start your free trial')).toBeNull();
  });

  it('hands the title back when the page is left', async () => {
    const { findByRole, unmount } = harness(null);
    await findByRole('heading', { name: 'Why Unbent exists' });
    unmount();
    expect(document.title).toBe('Unbent');
  });
});
