import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { Note } from '@unbent/shared';
import * as api from '../notes-api.js';
import { installTestLibrary } from '../store/test-library.js';
import type { Outbox, SyncStatus } from '../store/actions.js';
import { keys } from '../queries.js';
import { Workspace } from './Workspace.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  updateNote: vi.fn(),
}));

vi.mock('../store/use-outbox.js', () => ({
  useOutbox: vi.fn(),
  useSyncStatus: vi.fn(),
}));
import { useOutbox, useSyncStatus } from '../store/use-outbox.js';

/**
 * A conflict that comes back from the outbox, long after the save: the save went to the
 * local copy at once and to the server later, and the refusal arrived with the note
 * closed. Ending the entry rolled the row back to the server's copy, so opening the note
 * shows that — and the refusal must bring the typing back, or "Keep mine" keeps nothing.
 */
const server: Note = {
  id: 'n1',
  title: 'Trip notes',
  body: 'as opened on the desktop',
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 100,
  fields: [],
};
const theirs: Note = { ...server, body: 'as edited on the phone', updatedAt: 200 };
const typed = { title: 'Trip notes, typed on the plane', body: `${server.body}\n\nand a line typed on the plane`, tags: [], notebook: null, fields: {} };

/** A stand-in outbox: what the workspace subscribes to, with a conflict to hand it. */
function outbox(conflicts: Map<string, { current: Note; draft: typeof typed; base: Note }>) {
  const listeners = new Set<(s: SyncStatus) => void>();
  const status = (): SyncStatus => ({ pending: 0, durable: true, conflicts });
  const o = {
    status,
    subscribe: (l: (s: SyncStatus) => void) => {
      listeners.add(l);
      l(status());
      return () => void listeners.delete(l);
    },
    onAcknowledged: () => () => {},
    resolveConflict: vi.fn((id: string) => {
      conflicts.delete(id);
      listeners.forEach((l) => l(status()));
    }),
    dispose: async () => {},
    executor: {},
  } as unknown as Outbox;
  return o;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.attachments(server.id), []);
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.config(), { providers: [], autofill: false });
  client.setQueryData(keys.notebooks(), { notebooks: [], unfiled: 1 });
  const rootRoute = createRootRoute({ component: () => <Workspace noteId={server.id} /> });
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
}

const title = () => screen.findByPlaceholderText<HTMLInputElement>('Untitled');

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.mocked(useSyncStatus).mockReturnValue({ pending: 0, durable: true, conflicts: new Map() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('a conflict that comes back from the outbox', () => {
  it('puts the refused typing back on a note opened after the refusal, and Keep mine saves it', async () => {
    // The row is the server's copy: the ended entry rolled the typing back.
    const { tags: _t, notebook: _n, ...row } = server;
    const lib = installTestLibrary({ notes: [{ ...row, tagIds: [], files: [] }] });
    const o = outbox(new Map([[server.id, { current: theirs, draft: typed, base: server }]]));
    vi.mocked(useOutbox).mockReturnValue(o);
    vi.mocked(api.updateNote).mockResolvedValue({ ...theirs, title: typed.title, updatedAt: 201 });
    mount();

    // The typing, not the row, with the notice and the editor locked — the body too:
    // the editor seeds from the row unless told otherwise, and the row is the server's.
    await waitFor(async () => expect((await title()).value).toBe(typed.title));
    expect(screen.getByRole('alert').textContent).toContain('This note changed on another device.');
    expect((await title()).readOnly).toBe(true);
    await waitFor(() => expect(document.querySelector('.cm-content')?.textContent).toContain('and a line typed on the plane'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    });
    // Only what was typed, on top of theirs: the diff is against the copy the draft came
    // from, and the precondition is the other device's date.
    await waitFor(() => expect(api.updateNote).toHaveBeenCalled());
    expect(vi.mocked(api.updateNote).mock.calls[0]).toEqual([server.id, { title: typed.title, body: typed.body, ifUpdatedAt: 200 }]);
    expect(o.resolveConflict).toHaveBeenCalledWith(server.id);
    lib.uninstall();
  });

  it('Reload drops the typing for the other device’s version', async () => {
    const { tags: _t, notebook: _n, ...row } = server;
    const lib = installTestLibrary({ notes: [{ ...row, tagIds: [], files: [] }] });
    const o = outbox(new Map([[server.id, { current: theirs, draft: typed, base: server }]]));
    vi.mocked(useOutbox).mockReturnValue(o);
    mount();
    await waitFor(async () => expect((await title()).value).toBe(typed.title));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    });
    await waitFor(async () => expect((await title()).value).toBe('Trip notes'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.updateNote).not.toHaveBeenCalled();
    lib.uninstall();
  });
});
