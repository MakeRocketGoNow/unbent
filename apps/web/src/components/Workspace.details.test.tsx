import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import type { FieldDef, Note } from '@unbent/shared';
import { keys } from '../queries.js';
import { MOBILE_QUERY } from '../useMediaQuery.js';
import { Workspace } from './Workspace.js';

/**
 * Where the note's filing is drawn, and how it is reached.
 *
 * One set of controls with two containers: in flow on a desktop, in a sheet on a phone.
 * The thing worth asserting is that both really render the same controls and that the
 * phone's row is a way in rather than a label — the bug this replaced was a block that
 * grew unbounded between the title and the editor.
 */
const note: Note = {
  id: 'n1',
  title: 'Trail One',
  body: 'already written',
  tags: ['bikes'],
  notebook: 'Coupons',
  createdAt: 0,
  updatedAt: 0,
  fields: [],
};

const fieldDefs: FieldDef[] = [
  { id: 'f-code', notebookId: 'nb1', name: 'Code', type: 'text', options: [], position: 0 },
];

/** jsdom has no `showModal`; the sheet's own tests stub it the same way. */
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
}

function stubMedia(matches: (query: string) => boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.note(note.id), note);
  client.setQueryData(keys.attachments(note.id), []);
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.notebooks(), {
    notebooks: [{ id: 'nb1', name: 'Coupons', count: 1 }],
    unfiled: 0,
  });
  client.setQueryData(keys.notebookFields('nb1'), fieldDefs);

  const rootRoute = createRootRoute({ component: () => <Workspace noteId={note.id} /> });
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

const row = () => document.querySelector('.filing-row') as HTMLButtonElement | null;

beforeEach(stubDialog);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fireEvent.pointerDown(document.body);
});

describe('the note details on a phone', () => {
  beforeEach(() => stubMedia((q) => q === MOBILE_QUERY));

  it('states the filing on a row instead of spending the screen on controls', async () => {
    const { container } = mount();

    await waitFor(() => expect(row()).toBeTruthy());
    expect(row()!.textContent).toContain('Coupons');
    expect(row()!.textContent).toContain('#bikes');
    /*
       Nothing between the title and the editor but that one row.

       Tested as "no controls outside the sheet" rather than "no controls at all": the sheet
       renders its `<dialog>` and its children in the tree whether or not it is open, and a
       closed dialog is invisible because the platform does not paint it, not because React
       left it out. In flow is the thing that cost the screen, so in flow is what is asserted.
    */
    const inFlow = [...container.querySelectorAll('.tag-row')].filter((el) => !el.closest('dialog'));
    expect(inFlow).toHaveLength(0);
  });

  it('opens the controls in a sheet, without moving the note', async () => {
    mount();

    await waitFor(() => expect(row()).toBeTruthy());
    fireEvent.click(row()!);

    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-label')).toBe('Details');
    // The same controls the desktop renders in flow, now inside the sheet.
    expect(dialog.querySelector('.tag-row')).toBeTruthy();
    expect(screen.getByLabelText('Notebook')).toBeTruthy();
    expect(screen.getByLabelText('Code')).toBeTruthy();
  });

  /* A value typed in the sheet is the note's, so the row behind it has to say so. */
  it('carries an edited value back to the row', async () => {
    mount();

    await waitFor(() => expect(row()).toBeTruthy());
    fireEvent.click(row()!);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'T1-WWC-5G839' } });

    await waitFor(() => expect(row()!.textContent).toContain('Code: T1-WWC-5G839'));
  });
});

describe('the note details on a desktop', () => {
  beforeEach(() => stubMedia(() => false));

  it('keeps the controls in flow, with no row to open and no sheet', async () => {
    const { container } = mount();

    await waitFor(() => expect(container.querySelector('.tag-row')).toBeTruthy());
    expect(screen.getByLabelText('Notebook')).toBeTruthy();
    expect(row()).toBeNull();
    expect(document.querySelector('dialog')).toBeNull();
  });
});
