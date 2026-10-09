import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { Note } from '@unbent/shared';
import * as api from '../notes-api.js';
import { installTestLibrary } from '../store/test-library.js';
import type { Outbox } from '../store/actions.js';
import { keys } from '../queries.js';
import { seedFrom, type NoteDraft } from '../note-patch.js';
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
 * A save's answer can carry a change made elsewhere that did not move the note's date —
 * a notebook renamed, a tag merged in — and it becomes the next save's base. The draft
 * being typed must take what the person has not edited from it, or the next save sends
 * the stale value back. Both ways an answer arrives: from the outbox, and from a save
 * the server answered itself.
 */
const server: Note = {
  id: 'n1',
  title: 'Trip notes',
  body: 'Body',
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 100,
  fields: [],
};
const elsewhere = { tags: ['receipts'], notebook: 'Coupons' };

type Ack = (id: string, updated: Note, sent: NoteDraft) => void;

function outbox(onAck: (l: Ack) => void) {
  const status = () => ({ pending: 0, durable: true, waiting: new Set(), conflicts: new Map(), uploadNotices: new Map() });
  return {
    status,
    subscribe: (l: (s: ReturnType<typeof status>) => void) => {
      l(status());
      return () => {};
    },
    onAcknowledged: (l: Ack) => {
      onAck(l);
      return () => {};
    },
    resolveConflict: vi.fn(),
    dispose: async () => {},
    executor: {},
  } as unknown as Outbox;
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
const type = async (value: string) => {
  const input = await title();
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
};

let lib: ReturnType<typeof installTestLibrary>;

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.mocked(useSyncStatus).mockReturnValue({ pending: 0, durable: true, waiting: new Set(), conflicts: new Map(), uploadNotices: new Map() });
  const { tags: _t, notebook: _n, ...row } = server;
  lib = installTestLibrary({ notes: [{ ...row, tagIds: [], files: [] }] });
});

afterEach(() => {
  lib.uninstall();
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('a save answered while typing', () => {
  it('takes what the server changed elsewhere, so the next save does not send it back', async () => {
    vi.mocked(useOutbox).mockReturnValue(outbox(() => {}));
    vi.mocked(api.updateNote)
      .mockResolvedValueOnce({ ...server, ...elsewhere, title: 'Trip notes, one', updatedAt: 101 })
      .mockResolvedValueOnce({ ...server, ...elsewhere, title: 'Trip notes, two', updatedAt: 102 });
    mount();

    await type('Trip notes, one');
    await waitFor(() => expect(api.updateNote).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await type('Trip notes, two');
    await waitFor(() => expect(api.updateNote).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(vi.mocked(api.updateNote).mock.calls[1]).toEqual([server.id, { title: 'Trip notes, two', ifUpdatedAt: 101 }]);
  });

  it('stays Saved when the answer to a save with nothing typed since changed something elsewhere', async () => {
    vi.mocked(useOutbox).mockReturnValue(outbox(() => {}));
    vi.mocked(api.updateNote).mockResolvedValueOnce({ ...server, ...elsewhere, title: 'Trip notes, one', updatedAt: 101 });
    mount();

    await type('Trip notes, one');
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy(), { timeout: 3000 });
    // Past the autosave's delay: a rebase read as an edit would have cleared the label.
    await act(() => new Promise((r) => setTimeout(r, 1200)));
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(api.updateNote).toHaveBeenCalledTimes(1);
  });

  it('does not send the old tags with a keystroke typed and taken back while the save was out', async () => {
    vi.mocked(useOutbox).mockReturnValue(outbox(() => {}));
    let answer: (n: Note) => void = () => {};
    vi.mocked(api.updateNote)
      .mockImplementationOnce(() => new Promise<Note>((r) => (answer = r)))
      .mockImplementation(async (_id, patch) => ({ ...server, ...elsewhere, ...patch, updatedAt: 102 }) as Note);
    mount();

    await type('Trip notes, one');
    await waitFor(() => expect(api.updateNote).toHaveBeenCalledTimes(1), { timeout: 3000 });
    // Equal to what was sent again, but a new draft the autosave is now holding.
    await type('Trip notes, one!');
    await type('Trip notes, one');
    await act(async () => answer({ ...server, ...elsewhere, title: 'Trip notes, one', updatedAt: 101 }));
    await act(() => new Promise((r) => setTimeout(r, 1500)));
    for (const [, patch] of vi.mocked(api.updateNote).mock.calls.slice(1)) {
      expect(patch).not.toHaveProperty('tags');
      expect(patch).not.toHaveProperty('notebook');
    }
  });

  it('takes the same from an acknowledgement that lands mid-typing, and keeps the typing', async () => {
    let ack: Ack = () => {};
    vi.mocked(useOutbox).mockReturnValue(outbox((l) => (ack = l)));
    vi.mocked(api.updateNote).mockImplementation(async (_id, patch) => ({ ...server, ...elsewhere, ...patch, updatedAt: 102 }) as Note);
    mount();

    // Still inside the autosave's delay, so the draft is dirty when the answer comes.
    await type('Trip notes, typed');
    const sent = seedFrom(server);
    await act(async () => ack(server.id, { ...server, ...elsewhere, updatedAt: 101 }, sent));
    expect((await title()).value).toBe('Trip notes, typed');

    await waitFor(() => expect(api.updateNote).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(vi.mocked(api.updateNote).mock.calls[0]).toEqual([server.id, { title: 'Trip notes, typed', ifUpdatedAt: 101 }]);
  });
});
