import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { SearchResult } from '@unbent/shared';
import { SearchResults } from './SearchResults.js';

function mount(results: SearchResult[]) {
  const rootRoute = createRootRoute({
    component: () => (
      <ul>
        <SearchResults results={results} />
      </ul>
    ),
  });
  const noteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes/$noteId' });
  const history = createMemoryHistory({ initialEntries: ['/'] });
  const router = createRouter({ routeTree: rootRoute.addChildren([noteRoute]), history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<RouterProvider router={router as any} />);
}

const result = (r: Partial<SearchResult>): SearchResult => ({ id: 'n1', title: 'A note', updatedAt: 0, snippet: '', ...r });

afterEach(cleanup);

describe('search result snippets', () => {
  it('shows a body snippet as its words, not its markdown', async () => {
    mount([result({ snippet: '**Total** [<<Invoice>>.pdf](files/<<Invoice>>.pdf)' })]);
    const excerpt = (await screen.findByText('Total', { exact: false })).closest('.note-excerpt');
    expect(excerpt?.textContent).toBe('Total Invoice.pdf');
    expect([...excerpt!.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Invoice']);
  });

  it('shows a tag or a field value as it came, marks and all', async () => {
    mount([
      result({ id: 'n1', snippet: '#<<urgent>>', matchedTag: '#urgent' }),
      result({ id: 'n2', snippet: '**<<5>>** stars', matchedField: 'Rating' }),
      result({ id: 'n3', snippet: 'x << y <<z>>', matchedField: 'Formula' }),
    ]);
    const excerpts = [...(await screen.findAllByText('A note'))].map(
      (title) => title.parentElement?.querySelector('.note-excerpt')?.textContent,
    );
    expect(excerpts).toEqual(['#urgent', '**5** stars', 'x << y z']);
  });
});
