import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
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
import { keys } from '../queries.js';
import { Workspace } from './Workspace.js';

/**
 * The note's whole column takes a dragged file, not only its text — on a new note, one
 * line. Where a file lands is `noteDropZone`'s, tested beside it; these pin that the
 * workspace puts the zone on the column, takes it off in the preview, whose Attach button
 * is off too, and puts it back on the new editor a change of view builds.
 *
 * jsdom lays nothing out, so every rectangle is zero and a pointer anywhere on the column
 * is below the text.
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
  const column = result.container.querySelector<HTMLElement>('.workspace-main')!;
  // The zone goes on in an effect once the editor has reported its view, a render later.
  await waitFor(() => expect(dragOver(column).defaultPrevented).toBe(true));
  /** The editor showing now, which a change of view replaces. */
  const view = () => EditorView.findFromDOM(result.container.querySelector<HTMLElement>('.cm-content')!)!;
  /** Picks a view from the bar's switcher, which acts on the press. */
  const switchTo = (label: string) =>
    fireEvent.mouseDown(result.getByRole('radio', { name: label }), { button: 0 });
  return { column, view, switchTo };
}

/** A file dragged over `el`; jsdom has neither DragEvent nor DataTransfer. */
function dragOver(el: Element): Event {
  const event = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files: [], dropEffect: 'copy' },
  });
  Object.defineProperty(event, 'clientX', { value: 10 });
  Object.defineProperty(event, 'clientY', { value: 10 });
  el.dispatchEvent(event);
  return event;
}

/** Where the drop point is drawn, or null when it is not. */
function dropPoint(view: EditorView): number | null {
  const caret = view.dom.querySelector('.cm-dropCursor-caret');
  return caret ? view.posAtDOM(caret) : null;
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

describe('a file dragged over the note', () => {
  it('is taken anywhere on the column, and pointed at the end of the text', async () => {
    const { column, view } = await mount();
    expect(dragOver(column).defaultPrevented).toBe(true);
    expect(dropPoint(view())).toBe(note.body.length);
  });

  it('is not taken in the preview, where there is no point to show it by', async () => {
    const { column, switchTo } = await mount();
    switchTo('Preview');
    await waitFor(() => expect(column.querySelector('.panes.reading')).not.toBeNull());
    expect(dragOver(column).defaultPrevented).toBe(false);
  });

  it('is taken by the editor a change of view builds', async () => {
    const { column, view, switchTo } = await mount();
    const before = view();
    switchTo('Source');
    await waitFor(() => expect(view()).not.toBe(before));
    await waitFor(() => {
      expect(dragOver(column).defaultPrevented).toBe(true);
      expect(dropPoint(view())).toBe(note.body.length);
    });
  });
});
