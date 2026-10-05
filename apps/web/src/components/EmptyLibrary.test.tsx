import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { Note } from '@unbent/shared';
import * as actions from '../store/actions.js';
import { EmptyLibrary } from './EmptyLibrary.js';
import { WELCOME_BODY, WELCOME_TITLE } from '../welcome-note.js';

vi.mock('../store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/actions.js')>()),
  createNote: vi.fn(),
}));

function mount(heading?: 'h2' | 'h3') {
  const rootRoute = createRootRoute({ component: Outlet });
  const notesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notes',
    component: () => (
      <>
        <EmptyLibrary heading={heading} />
        <Outlet />
      </>
    ),
  });
  const noteRoute = createRoute({ getParentRoute: () => notesRoute, path: '$noteId' });
  const importRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/import' });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([notesRoute.addChildren([noteRoute]), importRoute]),
    history,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return { router };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EmptyLibrary', () => {
  it('is a region named by its heading', async () => {
    mount();
    const region = await screen.findByRole('region', { name: 'No notes yet' });
    expect(region).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'No notes yet' })).toBeTruthy();
  });

  it('takes the heading level it is given', async () => {
    mount('h3');
    expect(await screen.findByRole('heading', { level: 3, name: 'No notes yet' })).toBeTruthy();
  });

  /** Navigation stays a link, so it can be opened in a new tab; it is drawn as the primary. */
  it('offers the import as a link to its page, first in the tab order', async () => {
    mount();
    const link = await screen.findByRole('link', { name: 'Import from Evernote or Notion' });
    expect(link.getAttribute('href')).toBe('/settings/import');
    expect(link.className).toContain('btn-primary');
    const button = screen.getByRole('button', { name: 'New note' });
    // Before the button in document order, which is the tab order here.
    expect(link.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('makes a note filed nowhere and opens it, as New does from All notes', async () => {
    vi.mocked(actions.createNote).mockResolvedValue({ id: 'made' } as Note);
    const { router } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New note' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/notes/made'));
    expect(actions.createNote).toHaveBeenCalledWith({ title: '', body: '', tags: [], notebook: null });
  });

  /** The quiet third action: on its own line, after the two choices in the tab order. */
  it('offers a sample note as a quiet action after the two buttons', async () => {
    mount();
    const sample = await screen.findByRole('button', { name: 'See a sample note' });
    expect(sample.className).toContain('btn-quiet');
    expect(sample.closest('.empty-state-aside')).not.toBeNull();
    expect(sample.closest('.empty-state-actions')).toBeNull();
    const order = [
      screen.getByRole('link', { name: 'Import from Evernote or Notion' }),
      screen.getByRole('button', { name: 'New note' }),
      sample,
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('makes the sample note in no notebook, untagged, and opens it', async () => {
    vi.mocked(actions.createNote).mockResolvedValue({ id: 'sample' } as Note);
    const { router } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'See a sample note' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/notes/sample'));
    expect(actions.createNote).toHaveBeenCalledWith({
      title: WELCOME_TITLE,
      body: WELCOME_BODY,
      tags: [],
      notebook: null,
    });
  });

  /** A second press while the first is being made makes nothing; a failure gives the buttons back. */
  it('makes one note however often it is pressed, and is usable again after a failure', async () => {
    let fail: (err: Error) => void = () => {};
    vi.mocked(actions.createNote).mockImplementation(() => new Promise((_, reject) => (fail = reject)));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mount();
    const sample = await screen.findByRole<HTMLButtonElement>('button', { name: 'See a sample note' });
    fireEvent.click(sample);
    await waitFor(() => expect(sample.disabled).toBe(true));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New note' }).disabled).toBe(true);
    fireEvent.click(sample);
    expect(actions.createNote).toHaveBeenCalledTimes(1);

    fail(new Error('no room'));
    await waitFor(() => expect(sample.disabled).toBe(false));
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('draws its glyph for the eye only', async () => {
    mount();
    const region = await screen.findByRole('region', { name: 'No notes yet' });
    const mark = region.querySelector('.empty-state-mark');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
  });
});
