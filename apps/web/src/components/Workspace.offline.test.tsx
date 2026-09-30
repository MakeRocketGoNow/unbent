import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import type { Note } from '@unbent/shared';
import * as api from '../notes-api.js';
import { OfflineError } from '../notes-api.js';
import { keys } from '../queries.js';
import { noteRead, reportReachable, reportUnreachable } from '../connectivity.js';
import { Workspace } from './Workspace.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  updateNote: vi.fn(),
}));

/**
 * A note offline: readable, and nothing about it can change. Then the connection back:
 * a note that was open all along unlocks at once, and one whose copy came from the cache
 * stays locked until the server's copy replaces it — seeding the unlocked editor from the
 * old text is how an edit made on another device would be saved over.
 */
const note: Note = {
  id: 'n1',
  title: 'Trip notes',
  body: 'as read on the plane',
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 0,
  fields: [],
};

function mount(seed?: (client: QueryClient) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.note(note.id), note);
  client.setQueryData(keys.attachments(note.id), []);
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.config(), { providers: [], autofill: true });
  client.setQueryData(keys.notebooks(), { notebooks: [], unfiled: 1 });
  seed?.(client);
  vi.mocked(api.updateNote).mockImplementation(async (id, patch) => ({ ...note, id, ...patch }) as Note);

  const rootRoute = createRootRoute({ component: () => <Workspace noteId={note.id} /> });
  const notesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([notesRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return client;
}

const title = () => screen.findByPlaceholderText<HTMLInputElement>('Untitled');

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('a note while offline', () => {
  it('is readable, and nothing about it can be changed', async () => {
    mount();
    act(() => reportUnreachable());
    expect((await title()).readOnly).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'More actions' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Auto-fill' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Bold/ }).disabled).toBe(true);
  });

  it('unlocks when the connection returns, if it was read from the server', async () => {
    mount();
    act(() => reportUnreachable());
    expect((await title()).readOnly).toBe(true);
    act(() => reportReachable());
    await waitFor(async () => expect((await title()).readOnly).toBe(false));
  });

  it('stays locked after the connection returns while its copy came from the cache', async () => {
    mount();
    act(() => {
      noteRead(note.id, true);
      reportUnreachable();
    });
    act(() => reportReachable());
    expect((await title()).readOnly).toBe(true);
  });

  it('takes the server’s copy, not the cached one, when it unlocks', async () => {
    const client = mount();
    act(() => {
      noteRead(note.id, true);
    });
    expect((await title()).value).toBe('Trip notes');

    // The server answers with what another device saved meanwhile.
    act(() => {
      noteRead(note.id, false);
      client.setQueryData(keys.note(note.id), { ...note, title: 'Trip notes, day two', body: 'written at home' });
    });
    await waitFor(async () => expect((await title()).value).toBe('Trip notes, day two'));
    expect((await title()).readOnly).toBe(false);
    // Taken as the new baseline, not as an edit to save back.
    await new Promise((r) => setTimeout(r, 1000));
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it('says a note never opened here is not available, without calling it a failure', async () => {
    mount((client) => {
      client.removeQueries({ queryKey: keys.note(note.id) });
      client.setQueryDefaults(keys.note(note.id), {
        queryFn: () => Promise.reject(new OfflineError()),
      });
    });
    const line = await screen.findByText(
      "This note hasn't been opened on this device, so it isn't available offline.",
    );
    expect(line.className).toContain('muted');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
