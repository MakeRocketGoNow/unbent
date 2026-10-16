import { useState } from 'react';
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
import { installTestLibrary } from '../store/test-library.js';
import { Workspace } from './Workspace.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  updateNote: vi.fn(),
  getNote: vi.fn(),
}));
const { AUTOSAVE_MS, PAST_AUTOSAVE_MS } = vi.hoisted(() => ({ AUTOSAVE_MS: 150, PAST_AUTOSAVE_MS: 400 }));

// The autosave's real delay is 800 ms, and every save below pays it in full: the hook
// is what Workspace renders, so there is no other way through. The behaviour under test
// is the ordering of saves and answers, not the length of the pause, so the delay is
// shortened here: long enough that an answer arranged to land "inside the delay" still
// does on a loaded CI runner, and short enough that the file no longer takes most of
// its time waiting. The sleeps that wait "past the delay" below are sized against it.
vi.mock('../useAutosave.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../useAutosave.js')>();
  return {
    ...mod,
    useAutosave: ((value, save, opts) => mod.useAutosave(value, save, { delay: AUTOSAVE_MS, ...opts })) as typeof mod.useAutosave,
  };
});

/**
 * A note open here and saved on another device meanwhile (MAK-113).
 *
 * Every save names the copy it was made from, and a refusal must leave both versions
 * within reach: the typing on screen, locked, and the other device's one click away. The
 * benign refusal (the note moved on only in ways the draft already agrees with) saves
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

/** Which note the workspace has open; the tests that switch notes call it. */
let openNote: (id: string) => void = () => {};

function Host() {
  const [id, setId] = useState(note.id);
  openNote = setId;
  return <Workspace noteId={id} />;
}

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

  const rootRoute = createRootRoute({ component: Host });
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
  // The tests that hide or show the tab set it on the document itself; this brings back
  // the prototype's.
  delete (document as { visibilityState?: unknown }).visibilityState;
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
    await new Promise((r) => setTimeout(r, PAST_AUTOSAVE_MS));
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

  it('does not take its own slow save for another device', async () => {
    // A save slower than the debounce: the second edit's save must wait for the first to
    // come back, or both name the same copy and the second is refused.
    serverHolding(note);
    const server = vi.mocked(api.updateNote).getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(api.updateNote).mockImplementationOnce(async (id, patch) => {
      await held;
      return server(id, patch);
    });
    mount();

    await typeTitle('Grocer');
    await waitFor(() => expect(api.updateNote).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await typeTitle('Grocery');
    await new Promise((r) => setTimeout(r, PAST_AUTOSAVE_MS));
    expect(api.updateNote).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(api.updateNote).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(vi.mocked(api.updateNote).mock.calls.map((c) => [c[1].title, c[1].ifUpdatedAt])).toEqual([
      ['Grocer', 100],
      ['Grocery', 101],
    ]);
  });

  it('drops the refused typing when the note is left, rather than carrying it to the next', async () => {
    const other: Note = { ...note, id: 'n2', title: 'Packing list', updatedAt: 300 };
    serverHolding(phone);
    mount((client) => {
      client.setQueryData(keys.note(other.id), other);
      client.setQueryData(keys.attachments(other.id), []);
    });
    await typeTitle('Trip notes, typed here');
    await screen.findByRole('alert', {}, { timeout: 3000 });

    act(() => openNote(other.id));

    await waitFor(async () => expect((await title()).value).toBe('Packing list'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Not saved')).toBeNull();
    expect((await title()).readOnly).toBe(false);
    // Nothing more goes out for the note that was left, now or when the tab is hidden.
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await new Promise((r) => setTimeout(r, PAST_AUTOSAVE_MS));
    expect(api.updateNote).toHaveBeenCalledTimes(1);
  });

  it('lets a refusal that comes back after the note was left go quietly', async () => {
    // The last edit of note A is still out when the person moves to B, and the phone saved
    // A meanwhile. Nobody is on A to ask; B must not inherit A's question.
    const other: Note = { ...note, id: 'n2', title: 'Packing list', updatedAt: 300 };
    let refuse!: () => void;
    vi.mocked(api.updateNote).mockImplementationOnce(
      () => new Promise((_, reject) => (refuse = () => reject(new NoteChangedError(phone)))),
    );
    const client = mount((c) => {
      c.setQueryData(keys.note(other.id), other);
      c.setQueryData(keys.attachments(other.id), []);
    });
    await typeTitle('Trip notes, typed here');
    await waitFor(() => expect(api.updateNote).toHaveBeenCalledTimes(1), { timeout: 3000 });

    act(() => openNote(other.id));
    await waitFor(async () => expect((await title()).value).toBe('Packing list'));
    await act(async () => refuse());

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Not saved')).toBeNull();
    expect((await title()).readOnly).toBe(false);
    // What reopening A will show is the phone's copy, with nothing waiting to be decided.
    expect(client.getQueryData<Note>(keys.note(note.id))).toMatchObject({ body: 'as edited on the phone' });
    act(() => openNote(note.id));
    await waitFor(async () => expect((await title()).value).toBe('Trip notes'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks when the same edit was made elsewhere alongside one the draft does not have', async () => {
    // The phone renamed the note and rewrote the body; this tab types the same rename.
    // The rename alone would change nothing, but taking the phone's copy as current here
    // would leave the old body in the draft to be saved over the phone's on the next key.
    const server = serverHolding({ ...note, title: 'Trip notes, renamed', body: 'as edited on the phone', updatedAt: 200 });
    mount();
    await typeTitle('Trip notes, renamed');

    await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(api.updateNote).toHaveBeenCalledTimes(1);
    expect(server.get().body).toBe('as edited on the phone');
  });

  it('asks when its quiet second try is refused as well', async () => {
    // The first refusal is benign (the phone made the same rename) but a third save
    // lands before the retry does.
    const renamed: Note = { ...note, title: 'Trip notes, renamed', updatedAt: 200 };
    const third: Note = { ...renamed, body: 'and a third device', updatedAt: 300 };
    vi.mocked(api.updateNote)
      .mockRejectedValueOnce(new NoteChangedError(renamed))
      .mockRejectedValueOnce(new NoteChangedError(third));
    mount();
    await typeTitle('Trip notes, renamed');

    await screen.findByRole('alert', {}, { timeout: 3000 });
    expect((await title()).readOnly).toBe(true);
    expect(vi.mocked(api.updateNote).mock.calls.map((c) => c[1].ifUpdatedAt)).toEqual([100, 200]);

    // With a way out, which the bare refusal never offered.
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
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
    // The phone's copy is in the library (the feed put it there) and a refetch reads it.
    const { tags: _t, notebook: _n, ...row } = { ...phone, title: 'Trip notes, from the phone' };
    const lib = installTestLibrary({ notes: [{ ...row, tagIds: [], files: [] }] });
    mount();
    expect((await title()).value).toBe('Trip notes');

    await show();

    await waitFor(async () => expect((await title()).value).toBe('Trip notes, from the phone'));
    // Taken as the new baseline, not as an edit to save back.
    await new Promise((r) => setTimeout(r, PAST_AUTOSAVE_MS));
    expect(api.updateNote).not.toHaveBeenCalled();

    // The first keystroke after is made against that copy, and goes through.
    await typeTitle('Trip notes, from the phone, and here');
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy(), { timeout: 3000 });
    expect(vi.mocked(api.updateNote).mock.calls[0]?.[1]).toMatchObject({ ifUpdatedAt: 200 });
    lib.uninstall();
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
