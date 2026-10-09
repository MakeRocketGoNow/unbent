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
 * A press on the blank column under a note writes at its bottom — on a phone that blank is
 * most of the screen under a short note, and outside the editor. What the editor does with
 * it is `caretBelowEnd`'s, tested beside it; these pin which presses count.
 *
 * jsdom lays nothing out, so every rectangle is zero: the editor's bottom edge is 0, and
 * the column is given a content width so a press can land inside it or on its scrollbar.
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

const COLUMN_WIDTH = 800;

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

  const content = await waitFor(() => {
    const el = result.container.querySelector<HTMLElement>('.cm-content');
    if (!el) throw new Error('no editor yet');
    return el;
  });
  const view = EditorView.findFromDOM(content)!;
  const column = result.container.querySelector<HTMLElement>('.workspace-main')!;
  Object.defineProperty(column, 'clientWidth', { value: COLUMN_WIDTH });
  return { view, column };
}

const press = (el: Element, init: MouseEventInit = {}) =>
  fireEvent.mouseDown(el, { button: 0, clientX: 100, clientY: 100, ...init });

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
});

describe('a press on the column below a note', () => {
  it('puts the caret at the end of the note', async () => {
    const { view, column } = await mount();
    view.dispatch({ selection: { anchor: 0 } });
    press(column);
    expect(view.state.selection.main.head).toBe(note.body.length);
    expect(view.hasFocus).toBe(true);
  });

  it('leaves a press on something inside the column to that thing', async () => {
    const { view, column } = await mount();
    view.dispatch({ selection: { anchor: 0 } });
    press(column.querySelector('.fields-inline')!);
    expect(view.state.selection.main.head).toBe(0);
  });

  /** The column scrolls, so its scrollbar is part of it. */
  it('leaves a press on the column’s scrollbar alone', async () => {
    const { view, column } = await mount();
    view.dispatch({ selection: { anchor: 0 } });
    press(column, { clientX: COLUMN_WIDTH + 4 });
    expect(view.state.selection.main.head).toBe(0);
  });

  it('leaves a modified press alone', async () => {
    const { view, column } = await mount();
    view.dispatch({ selection: { anchor: 0 } });
    press(column, { shiftKey: true });
    expect(view.state.selection.main.head).toBe(0);
  });
});
