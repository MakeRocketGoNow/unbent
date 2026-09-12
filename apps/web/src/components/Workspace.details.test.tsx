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

  /*
   * The notebook and the tags are the first two rows of the property list, on the page —
   * not a row that opens a sheet. The sheet earned its place holding six controls; once
   * the fields moved onto the page it held two, and a modal surface for two controls the
   * row already showed was ceremony.
   */
  it('puts the notebook and the tags on the page as the first rows, with no sheet', async () => {
    const { container } = mount();

    await waitFor(() => expect(container.querySelector('.fields-inline')).toBeTruthy());
    expect(row()).toBeNull();
    expect(document.querySelector('dialog')).toBeNull();

    const inline = container.querySelector('.fields-inline')!;
    const notebook = screen.getByLabelText('Notebook') as unknown as HTMLSelectElement;
    expect(inline.contains(notebook)).toBe(true);
    expect(notebook.value).toBe('Coupons');
    // A chosen notebook is drawn as a chip, like a chosen select value on a field row.
    expect(notebook.getAttribute('data-filled')).toBe('true');
    expect(inline.querySelector('.tag-input')).toBeTruthy();
    expect(inline.textContent).toContain('bikes');

    // Before the fields, in the same grid: the first two `.note-field` rows are theirs.
    const rows = [...inline.querySelectorAll('.note-field')];
    expect(rows[0]?.textContent).toContain('Notebook');
    expect(rows[1]?.textContent).toContain('Tags');
    expect(rows[2]?.textContent).toContain('Code');
  });

  /*
   * The fields are the note's own data, so they are on the page, above the body, and
   * edited where they are read — not summarised on the row and edited in the sheet.
   */
  it('keeps the fields on the page above the note, editable in place', async () => {
    const { container } = mount();

    await waitFor(() => expect(container.querySelector('.fields-inline')).toBeTruthy());
    const inline = container.querySelector('.fields-inline');
    expect(inline!.closest('dialog')).toBeNull();
    const code = screen.getByLabelText('Code') as HTMLInputElement;
    expect(inline!.contains(code)).toBe(true);

    fireEvent.change(code, { target: { value: 'T1-WWC-5G839' } });
    await waitFor(() =>
      expect((screen.getByLabelText('Code') as HTMLInputElement).value).toBe('T1-WWC-5G839'),
    );
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

  /* A column of their own beside the note, so a long list never pushes the body down. */
  it('gives the fields a panel beside the note rather than a place above it', async () => {
    const { container } = mount();

    await waitFor(() => expect(container.querySelector('.fields-panel')).toBeTruthy());
    const panel = container.querySelector('.fields-panel')!;
    expect(panel.contains(screen.getByLabelText('Code'))).toBe(true);
    expect(container.querySelector('.tag-row .note-fields')).toBeNull();
    expect(container.querySelector('.workspace-main')!.contains(panel)).toBe(false);
  });
});
