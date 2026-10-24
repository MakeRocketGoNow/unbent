import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { FunctionComponent } from 'react';
import { keys } from '../queries.js';

const useSession = vi.fn();
vi.mock('../auth-client.js', () => ({ useSession: () => useSession() }));

const { CompareIndexPage, JoplinComparison, EvernoteComparison, NotionComparison, PaperlessNgxComparison } =
  await import('./ComparePage.js');
const { COMPARE_META, COMPARISONS, comparison } = await import('./comparisons.js');

/** The config seeded as `WhyPage.test` seeds it: the footer reads it and jsdom has no server. */
function harness(page: FunctionComponent, at: string, session: { user: { id: string } } | null = null) {
  useSession.mockReturnValue({ data: session, isPending: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), { providers: [], frontPage: true });
  const router = createRouter({
    routeTree: createRootRoute({ component: page }),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

const PAGES = [
  ['evernote', EvernoteComparison],
  ['notion', NotionComparison],
  ['joplin', JoplinComparison],
  ['paperless-ngx', PaperlessNgxComparison],
] as const;

describe('ComparePage', () => {
  afterEach(() => {
    cleanup();
    useSession.mockReset();
  });

  /**
   * The seven parts in their order on every page: both sides' strengths, under headings of
   * the same weight, and the one a vendor's comparison leaves out is there too.
   */
  it.each(PAGES)('draws the %s comparison whole, with the trial as the one filled control', async (slug, page) => {
    const c = comparison(slug);
    const { findByRole, getAllByRole, container } = harness(page, c.path);
    expect(await findByRole('heading', { level: 1, name: `Unbent and ${c.name}` })).toBeTruthy();
    expect(document.title).toBe(c.meta.title);
    expect(getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'The short version',
      'Why they differ',
      'Side by side',
      'What Unbent does better',
      `What ${c.name} does better`,
      c.switching.title,
      'More comparisons',
    ]);
    expect(container.querySelectorAll('.compare-table tbody tr')).toHaveLength(c.rows.length);
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  /** A stacked row on a phone names each cell's app from its label. */
  it('labels every cell with the app it describes', async () => {
    const { findByRole, container } = harness(JoplinComparison, '/compare/joplin');
    await findByRole('heading', { name: 'Side by side' });
    const labels = [...container.querySelectorAll('.compare-table tbody td')].map((td) => td.getAttribute('data-label'));
    expect(new Set(labels)).toEqual(new Set(['Unbent', 'Joplin']));
  });

  it('links the others, not itself, and the story', async () => {
    const { findByRole } = harness(NotionComparison, '/compare/notion');
    const more = (await findByRole('heading', { name: 'More comparisons' })).parentElement!;
    const hrefs = [...more.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/compare/evernote', '/compare/joplin', '/compare/paperless-ngx', '/why']);
  });

  it('gives someone signed in their notes as the way out, and no trial', async () => {
    const { findByText, queryByText } = harness(EvernoteComparison, '/compare/evernote', { user: { id: 'u1' } });
    expect((await findByText('Open your notes')).getAttribute('href')).toBe('/notes');
    expect(queryByText('Start your free trial')).toBeNull();
  });

  it('lists every comparison on /compare', async () => {
    const { findByRole, container } = harness(CompareIndexPage, '/compare');
    await findByRole('heading', { level: 1, name: 'How Unbent compares' });
    expect(document.title).toBe(COMPARE_META.title);
    const hrefs = [...container.querySelectorAll('.compare-index a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(COMPARISONS.map((c) => c.path));
  });
});

/** The rules `comparisons.tsx` sets itself, held where a test can hold them. */
describe('comparisons', () => {
  it.each(COMPARISONS.map((c) => [c.slug, c] as const))('keeps %s fair and sourced', (_, c) => {
    expect(c.weDoBetter.length).toBeGreaterThan(0);
    expect(c.theyDoBetter.length).toBeGreaterThan(0);
    expect(c.chooseThem.length).toBeGreaterThan(0);
    expect(c.whyTheyDiffer).toBeTruthy();
    expect(c.sources.length).toBeGreaterThan(0);
    for (const source of c.sources) expect(source.href).toMatch(/^https:\/\//);
    // The house rule for anything new: no em-dashes in copy.
    expect(JSON.stringify(c, (_k, v) => (typeof v === 'function' ? undefined : v))).not.toContain('—');
  });

  /** The same rows in the same order on every page, so two pages compare like with like. */
  it('asks every app the same questions in the same order', () => {
    const topics = (c: (typeof COMPARISONS)[number]) => c.rows.map((r) => r.topic).filter((t) => t !== 'Source');
    for (const c of COMPARISONS) expect(topics(c)).toEqual(topics(COMPARISONS[0]!));
  });
});
