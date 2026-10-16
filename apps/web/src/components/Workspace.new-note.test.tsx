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
import { keys } from '../queries.js';
import { markNewNote } from '../useNewNote.js';
import { TOUCH_QUERY } from '../useMediaQuery.js';
import { Workspace } from './Workspace.js';

/**
 * Where the caret lands when a note opens.
 *
 * A new note is the one case that goes to the title; everything else goes to the body. The
 * two are decided in different places (an effect here and the editor's `autoFocus`) and
 * getting either alone right still leaves the caret in the wrong field, so this asserts
 * what actually holds focus rather than the props behind it.
 *
 * The real editor is mounted for that reason: a stub could not take focus back, which is
 * the failure this is watching for.
 */
const note: Note = {
  id: 'n1',
  title: '',
  body: 'already written',
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 0,
};

/**
 * The workspace under a router, with every query already answered.
 *
 * Seeded rather than mocked, and never stale, so nothing this test is not about goes to
 * the network: a refetch in jsdom would land on a relative URL and fail, and the note is
 * exactly what focus is being decided from.
 */
function mount(noteOverrides: Partial<Note> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const seeded = { ...note, ...noteOverrides };
  client.setQueryData(keys.note(seeded.id), seeded);
  client.setQueryData(keys.attachments(seeded.id), []);
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.notebooks(), { notebooks: [], unfiled: 0 });

  const rootRoute = createRootRoute({
    component: () => <Workspace noteId={seeded.id} />,
  });
  // A child route the workspace's own links can point at, so `Link` resolves rather than
  // throwing on a route the router has never heard of.
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

const title = () => screen.getByPlaceholderText('Untitled');
const editorHost = () => document.querySelector('.cm-content');

/**
 * Lets the editor finish arriving.
 *
 * The view hands itself to the workspace as it mounts, and the workspace registers the way
 * into it a commit later, so there is a moment, after the title already has the caret,
 * when Enter has nothing to hand the note to. That is the documented behaviour of an Enter
 * pressed before an editor exists, and it is measured in one render rather than anything a
 * person could hit; here it is the difference between the test pressing the key and a user
 * doing it.
 */
const settle = () => act(async () => {});

/**
 * Answers each query on its own rather than answering `false` to everything.
 *
 * The workspace asks two questions now (the width and whether there is a keyboard) and
 * they are different questions with different answers, which a blanket stub cannot say.
 * jsdom ships no `matchMedia` at all, so this is also what keeps the component mountable.
 */
function stubMedia(matches: (query: string) => boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  // A mouse on a desktop: no keyboard to raise, so the body keeps the caret. The touch
  // tests below restub for the other answer.
  stubMedia(() => false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Both flags live at module scope, so they outlive a test unless they are put back.
  fireEvent.pointerDown(document.body);
});

describe('opening a note', () => {
  it('puts the caret in the title of a note that was just created', async () => {
    markNewNote('n1');
    mount();

    await waitFor(() => expect(document.activeElement).toBe(title()));
    // The point of the flag: the editor mounts in the same commit and must stand down
    // rather than take the focus straight back.
    expect(document.activeElement).not.toBe(editorHost());
  });

  it('leaves the title empty rather than selecting a word to type over', async () => {
    markNewNote('n1');
    mount();

    await waitFor(() => expect(document.activeElement).toBe(title()));
    // Nothing to type over, so nothing a stray click or arrow press can turn into
    // "UntitledMeeting notes". The word on screen is the placeholder.
    expect(title()).toHaveProperty('value', '');
  });

  it('puts the caret in the body of a note that already exists', async () => {
    mount();

    await waitFor(() => expect(editorHost()).toBeTruthy());
    expect(document.activeElement).toBe(editorHost());
  });

  /*
     The claim is spent on the note it was made for. Without this, opening a second note in
     the same session would find the flag still set and take its title.
  */
  it('does not treat another note as new', async () => {
    markNewNote('somewhere-else');
    mount();

    await waitFor(() => expect(editorHost()).toBeTruthy());
    expect(document.activeElement).toBe(editorHost());
  });

  /*
     The keyboard costs half the screen, so nothing takes focus on a phone by itself.

     Keyed on the pointer rather than the width: a tablet at 1024px is not `MOBILE_QUERY`
     and still raises a keyboard. Asserted as "the body has focus" rather than "the editor
     does not", because a caret parked anywhere is the failure: the screen has to open
     with nothing focused at all.
  */
  it('leaves an existing note unfocused on a touch device', async () => {
    stubMedia((q) => q === TOUCH_QUERY);
    mount();

    await waitFor(() => expect(editorHost()).toBeTruthy());
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  /*
     The exception. A note that was just created was created to be typed into, and the
     keyboard is what you asked for, so the title still takes the caret on a phone.
  */
  it('still puts the caret in the title of a new note on a touch device', async () => {
    stubMedia((q) => q === TOUCH_QUERY);
    markNewNote('n1');
    mount();

    await waitFor(() => expect(document.activeElement).toBe(title()));
  });

  it('hands the note over to the body when Enter is pressed in the title', async () => {
    markNewNote('n1');
    mount();

    await waitFor(() => expect(document.activeElement).toBe(title()));
    await settle();
    fireEvent.keyDown(title(), { key: 'Enter' });

    expect(document.activeElement).toBe(editorHost());
  });
});
