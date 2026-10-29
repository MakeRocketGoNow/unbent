import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import { EditorView } from '@codemirror/view';
import type { Note } from '@unbent/shared';
import type { UploadedFile } from '../notes-api.js';
import * as actions from '../store/actions.js';
import { keys } from '../queries.js';
import { pageBusy } from '../busy.js';
import { insertUploads } from '../editor/attach.js';
import { Workspace } from './Workspace.js';

vi.mock('../store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/actions.js')>()),
  uploadFile: vi.fn(),
}));

vi.mock('../index-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../index-files.js')>()),
  indexUploadedFile: vi.fn(),
}));

/**
 * A file still uploading keeps the page busy, so the update notice's Reload waits for it
 * (`pageBusy` in `busy.ts`): the bytes are in this page and nowhere else until the
 * server has them. The hold is the count's own, not an effect's on the workspace: going
 * back to the list mid-upload unmounts the workspace while the upload runs on, and a
 * hold tied to the component let go of the page then, so a Reload pressed in that
 * window cut the file off half-way to the server.
 */
const note: Note = {
  id: 'n1',
  title: 'Short note',
  body: 'a line of text',
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 0,
  fields: [],
};

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.note(note.id), note);
  client.setQueryData(keys.attachments(note.id), []);
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.config(), { providers: [] });
  client.setQueryData(keys.notebooks(), { notebooks: [], unfiled: 1 });

  const rootRoute = createRootRoute({ component: () => <Workspace noteId={note.id} /> });
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
  await waitFor(() => {
    if (!result.container.querySelector('.cm-content')) throw new Error('no editor yet');
  });
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>('.cm-content')!)!;
  return { view, unmount: result.unmount };
}

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
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Workspace holds the page for an upload', () => {

  it('until it lands, through the workspace being unmounted', async () => {
    let finish: (uploaded: UploadedFile) => void = () => {};
    vi.mocked(actions.uploadFile).mockImplementation(
      () => new Promise<UploadedFile>((resolve) => { finish = resolve; }),
    );
    const { view, unmount } = await mount();
    expect(pageBusy()).toBe(false);

    const done = insertUploads(view, [new File(['x'], 'a.png', { type: 'image/png' })], 0);
    await waitFor(() => expect(actions.uploadFile).toHaveBeenCalledTimes(1));
    expect(pageBusy()).toBe(true);

    unmount();
    expect(pageBusy()).toBe(true);

    finish({ filename: 'a.png', contentType: 'image/png', size: 1, path: 'files/a.png' });
    await done;
    expect(pageBusy()).toBe(false);
  });
});
