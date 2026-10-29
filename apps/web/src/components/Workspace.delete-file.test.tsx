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
import { EditorView } from '@codemirror/view';
import type { AttachmentInfo, Note } from '@unbent/shared';
import * as api from '../notes-api.js';
import { keys } from '../queries.js';
import { Workspace } from './Workspace.js';

vi.mock('../store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/actions.js')>()),
  // No library in this test, so nothing is waiting to upload: every delete is the server's.
  deleteOrCancelAttachment: vi.fn(async (noteId: string, filename: string) => {
    await (await import('../notes-api.js')).deleteAttachment(noteId, filename);
  }),
}));

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  deleteAttachment: vi.fn(),
  fetchWebImage: vi.fn(),
  updateNote: vi.fn(),
}));

/**
 * The bin on a picture in the rich editor deletes the file on the server and then takes
 * the picture's markdown out of the note. The round trip is long enough to switch the
 * editor to Source meanwhile, or to arrow to the next note, and the removal must land in
 * the editor that is open when the delete finishes: the widget used to dispatch it into
 * the view it was built in, which a switch had destroyed, and CodeMirror takes a dispatch
 * to a destroyed view without a word.
 */
const scan: AttachmentInfo = { filename: 'scan.jpg', contentType: 'image/jpeg', size: 1000 };

const withPicture: Note = {
  id: 'n1',
  title: 'Receipt',
  body: 'before\n\n![scan](files/scan.jpg)\n\nafter',
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 0,
  fields: [],
};

/** A second note already written, so a removal for `withPicture` landing here is visible. */
const other: Note = {
  id: 'n2',
  title: 'Weekly review',
  body: 'already written',
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 0,
  fields: [],
};

const WEB_IMAGE = 'https://example.com/pic.png';

/** A note drawing a web image, so the picture's save control is offered. */
const withWebImage: Note = {
  id: 'n1',
  title: 'Trip notes',
  body: `![Diagram](${WEB_IMAGE})`,
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 0,
  fields: [],
};

/** A second note drawing the same address, where a relink by address would show. */
const alsoWebImage: Note = {
  id: 'n2',
  title: 'Weekly review',
  body: `![Diagram](${WEB_IMAGE})`,
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 0,
  fields: [],
};

function mount(note: Note, others: Note[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.note(note.id), note);
  client.setQueryData(keys.attachments(note.id), [scan]);
  for (const o of others) {
    client.setQueryData(keys.note(o.id), o);
    client.setQueryData(keys.attachments(o.id), []);
  }
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.config(), { providers: [] });
  client.setQueryData(keys.notebooks(), { notebooks: [], unfiled: 1 + others.length });
  vi.mocked(api.updateNote).mockImplementation(async (id, patch) => {
    const current = client.getQueryData<Note>(keys.note(id));
    return { ...(current ?? note), id, ...patch } as Note;
  });

  // Workspace is reused across notes: a new `noteId` prop, not a remount, as the
  // "Save web images" harness switches too.
  function Harness() {
    const [id, setId] = useState(note.id);
    return (
      <>
        {others.map((o) => (
          <button key={o.id} type="button" onClick={() => setId(o.id)}>
            Open {o.id}
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
  const result = render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  const view = () => EditorView.findFromDOM(result.container.querySelector<HTMLElement>('.cm-content')!)!;
  /** Picks a view from the bar's switcher, which acts on the press. */
  const switchTo = (label: string) => fireEvent.mouseDown(screen.getByRole('radio', { name: label }), { button: 0 });
  return { container: result.container, view, switchTo };
}

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
  // The view switcher's choice is remembered, and the next test wants the picture drawn.
  localStorage.clear();
});

/** Presses the bin on the picture and answers its question; the delete is then in flight. */
async function pressDelete(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector('.cm-md-image .zoom-remove')).not.toBeNull());
  container.querySelector<HTMLButtonElement>('.cm-md-image .zoom-remove')!.click();
  [...container.querySelectorAll<HTMLButtonElement>('.cm-md-image .attachment-tool-confirm')]
    .find((b) => b.textContent === 'Delete')!
    .click();
  await waitFor(() => expect(api.deleteAttachment).toHaveBeenCalledWith('n1', 'scan.jpg'));
}

/** A delete the test finishes by hand. */
function deferredDelete() {
  let finish: () => void = () => {};
  vi.mocked(api.deleteAttachment).mockImplementation(() => new Promise((resolve) => { finish = () => resolve(); }));
  return () => finish();
}

describe('Delete file on a picture', () => {
  it('takes the picture out of the note once the file has gone', async () => {
    vi.mocked(api.deleteAttachment).mockResolvedValue(undefined);
    const { container, view } = mount(withPicture);
    await pressDelete(container);
    await waitFor(() => expect(view().state.doc.toString()).toBe('before\n\nafter'));
  });

  it('writes to the editor open when the delete lands, not the one at the press', async () => {
    const finish = deferredDelete();
    const { container, view, switchTo } = mount(withPicture);
    await pressDelete(container);

    const pressed = view();
    switchTo('Source');
    await waitFor(() => expect(view()).not.toBe(pressed));
    expect(view().state.doc.toString()).toBe(withPicture.body);

    finish();
    await act(async () => {
      await Promise.resolve();
    });
    expect(view().state.doc.toString()).toBe('before\n\nafter');
  });

  it('leaves the next note alone when the delete lands after a switch', async () => {
    const finish = deferredDelete();
    const { container, view } = mount(withPicture, [other]);
    await pressDelete(container);

    fireEvent.click(screen.getByRole('button', { name: 'Open n2' }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Weekly review'),
    );

    finish();
    await act(async () => {
      await Promise.resolve();
    });
    expect(view().state.doc.toString()).toBe('already written');
    expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Weekly review');
  });
});

/**
 * The getter `Workspace` hands `Editor` for a write that lands after a round trip is
 * guarded by note: after a switch its ref holds the next note's view, and a web image
 * relinked by its address would be written into that note. The second note draws the
 * same address here, so a relink landing on it would show.
 */
describe('Save to note on a picture', () => {
  it('leaves the next note alone when the fetch lands after a switch', async () => {
    let finish: (filename: string) => void = () => {};
    vi.mocked(api.fetchWebImage).mockImplementation(
      () => new Promise((resolve) => { finish = (filename) => resolve({ filename } as Awaited<ReturnType<typeof api.fetchWebImage>>); }),
    );
    const { container, view } = mount(withWebImage, [alsoWebImage]);
    await waitFor(() => expect(container.querySelector('.cm-md-image .zoom-save')).not.toBeNull());
    container.querySelector<HTMLButtonElement>('.cm-md-image .zoom-save')!.click();
    await waitFor(() => expect(api.fetchWebImage).toHaveBeenCalledWith('n1', WEB_IMAGE));

    fireEvent.click(screen.getByRole('button', { name: 'Open n2' }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Weekly review'),
    );

    finish('pic.png');
    await act(async () => {
      await Promise.resolve();
    });
    expect(view().state.doc.toString()).toBe(alsoWebImage.body);
  });
});
