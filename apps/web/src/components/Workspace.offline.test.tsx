import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
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
import { installTestLibrary } from '../store/test-library.js';
import { keys } from '../queries.js';
import { setReachableForTests } from '../connectivity.js';
import { Workspace } from './Workspace.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  updateNote: vi.fn(),
  getNote: vi.fn(),
}));

/**
 * A note offline: as editable as online, since it is read from the local copy of the
 * library and a save goes to the outbox; what fades is what needs the server now, and it
 * comes back with the connection. And a note the copy does not hold yet, which is the
 * copy missing rather than the note.
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
  it('is editable: the local copy takes the typing and the outbox the save; only what needs the server fades', async () => {
    mount();
    act(() => setReachableForTests(false));
    expect((await title()).readOnly).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Bold/ }).disabled).toBe(false);
    // Auto-fill reads the note on the server and the ⋯ menu's actions all need it.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Auto-fill' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Auto-fill' }).title).toBe('Auto-fill needs a connection');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'More actions' }).disabled).toBe(true);
  });

  it('takes a save offline and shows it saved, where the lock used to be', async () => {
    mount();
    act(() => setReachableForTests(false));
    fireEvent.change(await title(), { target: { value: 'Trip notes, on the plane' } });
    await waitFor(() => expect(api.updateNote).toHaveBeenCalled(), { timeout: 3000 });
    expect(vi.mocked(api.updateNote).mock.calls[0]?.[1]).toMatchObject({ title: 'Trip notes, on the plane' });
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy(), { timeout: 3000 });
    expect((await title()).readOnly).toBe(false);
  });

  it('enables what needs the server when the connection returns', async () => {
    mount();
    act(() => setReachableForTests(false));
    await title();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Auto-fill' }).disabled).toBe(true);
    act(() => setReachableForTests(true));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Auto-fill' }).disabled).toBe(false));
  });

  it('says a note the copy does not hold yet is not available offline, without calling it a failure', async () => {
    // A library that has never taken its snapshot: the copy, not the note, is what is missing.
    const lib = installTestLibrary({ cursor: null });
    act(() => setReachableForTests(false));
    mount((client) => {
      client.removeQueries({ queryKey: keys.note(note.id) });
    });
    const line = await screen.findByText(
      "This note isn't on this device yet. It will be once your notes have finished copying here.",
    );
    expect(line.className).toContain('muted');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(api.getNote).not.toHaveBeenCalled();
    lib.uninstall();
  });

  it('asks the server for a note the copy does not hold yet while there is a connection', async () => {
    // A link followed during the first copy, which on a phone can take minutes.
    const lib = installTestLibrary({ cursor: null });
    vi.mocked(api.getNote).mockResolvedValue({ ...note, title: 'Trip notes, from the server' });
    mount((client) => {
      client.removeQueries({ queryKey: keys.note(note.id) });
    });
    expect((await title()).value).toBe('Trip notes, from the server');
    expect(api.getNote).toHaveBeenCalledWith(note.id);
    lib.uninstall();
  });
});
