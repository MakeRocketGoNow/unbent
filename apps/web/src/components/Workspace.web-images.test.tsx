import { useState } from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
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
import { keys } from '../queries.js';
import { Workspace } from './Workspace.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  fetchWebImage: vi.fn(),
  updateNote: vi.fn(),
}));

/**
 * "Save web images" fetches every remote image the body draws and points the body at the
 * copies. Its pass is long (one request per address, in sequence), so arrowing to the
 * next note while it runs is the ordinary thing, and the copies must not land on that note.
 */
const IMAGE_URL = 'https://example.com/pic.png';

function seedNote(client: QueryClient, note: Note) {
  client.setQueryData(keys.note(note.id), note);
  client.setQueryData(keys.attachments(note.id), []);
}

function mount(note: Note, others: Note[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seedNote(client, note);
  for (const other of others) seedNote(client, other);
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.config(), { providers: [] });
  client.setQueryData(keys.notebooks(), {
    notebooks: [{ id: 'nb-coupons', name: 'Coupons', count: 1, fields: 0 }],
    unfiled: 1,
  });
  client.setQueryData(keys.notebookFields('nb-coupons'), []);
  vi.mocked(api.updateNote).mockImplementation(async (id, patch) => {
    const current = client.getQueryData<Note>(keys.note(id));
    return { ...(current ?? note), id, ...patch } as Note;
  });

  /*
     Workspace is reused across notes: a new `noteId` prop, not a remount. The harness
     switches the same way so a "Save web images" pass for one note can be watched trying
     to land on another. Mirrors the Auto-fill test's harness.
  */
  function Harness() {
    const [id, setId] = useState(note.id);
    return (
      <>
        {others.map((other) => (
          <button key={other.id} type="button" onClick={() => setId(other.id)}>
            Open {other.id}
          </button>
        ))}
        <Workspace noteId={id} />
      </>
    );
  }

  const rootRoute = createRootRoute({ component: () => <Harness /> });
  const notesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([notesRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

/** A note whose body draws one web image, so the "Save web images" action is offered. */
const withImage: Note = {
  id: 'n1',
  title: 'Trip notes',
  body: `![Diagram](${IMAGE_URL})`,
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 0,
  fields: [],
};

/** A second note already written, so a rewrite for `withImage` landing here is visible. */
const other: Note = {
  id: 'n2',
  title: 'Weekly review',
  body: 'already written',
  tags: [],
  notebook: 'Coupons',
  createdAt: 0,
  updatedAt: 0,
  fields: [],
};

/** jsdom has neither; the workspace asks both on mount. The other Workspace tests do the same. */
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
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

async function startSaving() {
  fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 web image' }));
  await waitFor(() => expect(api.fetchWebImage).toHaveBeenCalledWith('n1', IMAGE_URL));
}

describe('Save web images', () => {
  it('saves the image and says how many it saved', async () => {
    vi.mocked(api.fetchWebImage).mockResolvedValue({ filename: 'pic.png' } as Awaited<
      ReturnType<typeof api.fetchWebImage>
    >);
    mount(withImage);
    await startSaving();
    expect(await screen.findByText('Saved 1 image')).toBeTruthy();
  });

  it('does not rewrite the next note when the pass finishes after a switch', async () => {
    type Fetched = Awaited<ReturnType<typeof api.fetchWebImage>>;
    let finish: (value: Fetched) => void = () => {};
    vi.mocked(api.fetchWebImage).mockImplementation(
      () => new Promise<Fetched>((resolve) => { finish = resolve; }),
    );
    mount(withImage, [other]);
    await startSaving();
    expect(screen.getByText('Saving 1 of 1…')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open n2' }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Weekly review'),
    );
    // The switch drops the previous note's "Saving…" from the head.
    expect(screen.queryByText('Saving 1 of 1…')).toBeNull();

    finish({ filename: 'pic.png' } as Fetched);
    // The continuation is a microtask. Flush it (and the render it would cause) so a
    // rewrite of this note would already be visible before we assert it did not happen.
    await act(async () => {
      await Promise.resolve();
    });
    // rewriteBody and the "Saved …" status share one note-guarded block; neither lands on n2.
    expect(screen.queryByText('Saved 1 image')).toBeNull();
    expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Weekly review');
  });
});
