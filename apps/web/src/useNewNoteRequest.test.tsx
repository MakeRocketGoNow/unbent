import { StrictMode } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
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
import * as actions from './store/actions.js';
import { filters } from './routes/notes.js';
import { useNewNoteRequest } from './useNewNoteRequest.js';

vi.mock('./store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store/actions.js')>()),
  createNote: vi.fn(),
}));

/**
 * `/notes?new=1`, the address an app's "New note" shortcut opens: one note per request,
 * filed nowhere whatever the link says, and the request replaced in the history so that
 * neither Back nor a reload makes another.
 */
function mount(entries: string[]) {
  const rootRoute = createRootRoute({ component: Outlet });
  const notesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notes',
    validateSearch: filters,
    component: function Notes() {
      useNewNoteRequest(notesRoute.useSearch().new);
      return <Outlet />;
    },
  });
  const noteRoute = createRoute({ getParentRoute: () => notesRoute, path: '$noteId' });
  const history = createMemoryHistory({ initialEntries: entries, initialIndex: entries.length - 1 });
  const router = createRouter({ routeTree: rootRoute.addChildren([notesRoute.addChildren([noteRoute])]), history });
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>
    </StrictMode>,
  );
  return { router, history };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a request for a new note from the address', () => {
  it('makes one note, filed nowhere, and replaces the request with it', async () => {
    vi.mocked(actions.createNote).mockResolvedValue({ id: 'made' } as Note);
    const { router, history } = mount(['/notes', '/notes?new=1&notebook=Anything&tag=%5B%22x%22%5D']);

    await waitFor(() => expect(router.state.location.pathname).toBe('/notes/made'));
    expect(actions.createNote).toHaveBeenCalledTimes(1);
    expect(actions.createNote).toHaveBeenCalledWith({ title: '', body: '', tags: [], notebook: null });
    expect(router.state.location.href).not.toMatch(/[?&]new=/);
    expect(history.length).toBe(2);

    history.back();
    await waitFor(() => expect(router.state.location.href).toBe('/notes'));
    expect(actions.createNote).toHaveBeenCalledTimes(1);
  });

  it('clears a request whose note could not be made, rather than trying again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(actions.createNote).mockRejectedValue(new Error('refused'));
    const { router, history } = mount(['/notes?new=1']);

    await waitFor(() => expect(router.state.location.href).toBe('/notes'));
    expect(history.length).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(actions.createNote).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a request', async () => {
    const { router } = mount(['/notes?new=0']);
    await waitFor(() => expect(router.state.status).toBe('idle'));
    expect(actions.createNote).not.toHaveBeenCalled();
  });
});
