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
import { NoteChangedError } from '../notes-api.js';
import { keys } from '../queries.js';
import { Workspace } from './Workspace.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  updateNote: vi.fn(),
  getNote: vi.fn(),
}));

/**
 * A note open here and saved on another device meanwhile (MAK-113).
 *
 * Every save names the copy it was made from, and a refusal must leave both versions
 * within reach: the typing on screen, locked, and the other device's one click away. The
 * benign refusal — the note moved on only in ways the draft already agrees with — saves
 * again without asking. And coming back to the tab with nothing typed takes the server's
 * copy before the first keystroke, so the refusal is rare in the first place.
 */
const note: Note = {
  id: 'n1',
  title: 'Trip notes',
  body: 'as opened on the desktop',
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 100,
  fields: [],
};

/** The same note as the phone saved it. */
const phone: Note = { ...note, body: 'as edited on the phone', updatedAt: 200 };

function mount(seed?: (client: QueryClient) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.note(note.id), note);
  client.setQueryData(keys.attachments(note.id), []);
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.config(), { providers: [], autofill: false });
  client.setQueryData(keys.notebooks(), { notebooks: [], unfiled: 1 });
  seed?.(client);

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

/** The server: refuses any save not made against what it holds, as the API does. */
function serverHolding(start: Note) {
  let stored = start;
  vi.mocked(api.updateNote).mockImplementation(async (_id, { ifUpdatedAt, ...patch }) => {
    if (ifUpdatedAt !== undefined && ifUpdatedAt !== stored.updatedAt) throw new NoteChangedError(stored);
    stored = { ...stored, ...patch, updatedAt: stored.updatedAt + 1 } as Note;
    return stored;
  });
  return { get: () => stored };
}

const title = () => screen.findByPlaceholderText<HTMLInputElement>('Untitled');

async function typeTitle(value: string) {
  fireEvent.change(await title(), { target: { value } });
}

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

describe('a save after another device saved the note', () => {
  it('sends the copy it was made from, and says so when it is refused', async () => {
    serverHolding(phone);
    mount();
    await typeTitle('Trip notes, typed here');

    const banner = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(banner.textContent).toContain('This note changed on another device.');
    expect(vi.mocked(api.updateNote).mock.calls[0]?.[1]).toEqual({
      title: 'Trip notes, typed here',
      ifUpdatedAt: 100,
    });

    // The typing stays on screen, locked until a choice is made.
    expect((await title()).value).toBe('Trip notes, typed here');
    expect((await title()).readOnly).toBe(true);
    expect(screen.getByText('Not saved')).toBeTruthy();
  });

  it('Reload replaces the typing with the other device’s version and saves nothing', async () => {
    const server = serverHolding(phone);
    mount();
    await typeTitle('Trip notes, typed here');
    await screen.findByRole('alert', {}, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(async () => expect((await title()).value).toBe('Trip notes'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((await title()).readOnly).toBe(false);
    await new Promise((r) => setTimeout(r, 1000));
    expect(api.updateNote).toHaveBeenCalledTimes(1);
    expect(server.get().body).toBe('as edited on the phone');

    // And the next edit is made against the copy it now shows.
    await typeTitle('Trip notes, again');
    await waitFor(() => expect(server.get().title).toBe('Trip notes, again'), { timeout: 3000 });
    expect(vi.mocked(api.updateNote).mock.calls[1]?.[1]).toMatchObject({ ifUpdatedAt: 200 });
  });

  it('Keep mine saves the typing over that version, and keeps what it did not touch', async () => {
    const server = serverHolding(phone);
    mount();
    await typeTitle('Trip notes, typed here');
    await screen.findByRole('alert', {}, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(vi.mocked(api.updateNote).mock.calls[1]?.[1]).toEqual({
      title: 'Trip notes, typed here',
      ifUpdatedAt: 200,
    });
    // The title is this tab's; the body the phone wrote, which this tab never changed, stays.
    expect(server.get()).toMatchObject({ title: 'Trip notes, typed here', body: 'as edited on the phone' });
    expect((await title()).value).toBe('Trip notes, typed here');
    expect((await title()).readOnly).toBe(false);
  });

  it('saves again without asking when the note only moved on to what the draft already says', async () => {
    // Both devices made the same rename; the phone's save landed first.
    serverHolding({ ...note, title: 'Trip notes, renamed', updatedAt: 200 });
    mount();
    await typeTitle('Trip notes, renamed');

    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(vi.mocked(api.updateNote).mock.calls.map((c) => c[1].ifUpdatedAt)).toEqual([100, 200]);
  });
});

describe('coming back to the tab', () => {
  async function show() {
    // The listener is added by an effect of the render that seeded the draft, which the
    // findBy before this can resolve ahead of.
    await act(async () => {});
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }

  it('takes the server’s copy when nothing has been typed', async () => {
    serverHolding(phone);
    vi.mocked(api.getNote).mockResolvedValue({ ...phone, title: 'Trip notes, from the phone' });
    mount();
    expect((await title()).value).toBe('Trip notes');

    await show();

    await waitFor(async () => expect((await title()).value).toBe('Trip notes, from the phone'));
    // Taken as the new baseline, not as an edit to save back.
    await new Promise((r) => setTimeout(r, 1000));
    expect(api.updateNote).not.toHaveBeenCalled();

    // The first keystroke after is made against that copy, and goes through.
    await typeTitle('Trip notes, from the phone, and here');
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy(), { timeout: 3000 });
    expect(vi.mocked(api.updateNote).mock.calls[0]?.[1]).toMatchObject({ ifUpdatedAt: 200 });
  });

  it('leaves typing that has not been saved alone', async () => {
    serverHolding(phone);
    vi.mocked(api.getNote).mockResolvedValue({ ...phone, title: 'Trip notes, from the phone' });
    mount();
    await typeTitle('Trip notes, typed here');

    await show();

    expect(api.getNote).not.toHaveBeenCalled();
    expect((await title()).value).toBe('Trip notes, typed here');
  });
});
