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
 * One property list (the notebook, the tags, then the fields) above the body at every
 * width, open, edited where it is read. The bugs this replaced were a block that grew
 * unbounded between the title and the editor, a sheet before that, a desktop that drew
 * the same record as a row of pickers plus a column beside the note, and lastly a fold
 * that closed the list at one width alone.
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
  { id: 'f-code', notebookId: 'nb1', name: 'Code', type: 'text', options: [], scale: null, currency: null, position: 0 },
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

beforeEach(stubDialog);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fireEvent.pointerDown(document.body);
});

/**
 * The list as every width draws it: on the page inside the note's column, with no sheet
 * and no row that opens one, the notebook and the tags as its first two rows and the
 * fields after them, and nothing beside the note, since the column the fields used to
 * have is gone.
 */
async function expectPropertyList(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector('.fields-inline')).toBeTruthy());
  const inline = container.querySelector('.fields-inline')!;
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.querySelector('.filing-row')).toBeNull();
  expect(container.querySelector('.fields-panel')).toBeNull();
  expect(container.querySelector('.tag-row')).toBeNull();
  expect(container.querySelector('.workspace-main')!.contains(inline)).toBe(true);

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
  expect(inline.contains(screen.getByLabelText('Code'))).toBe(true);
  return inline;
}

describe('the note details on a phone', () => {
  beforeEach(() => stubMedia((q) => q === MOBILE_QUERY));

  it('puts the notebook, the tags and the fields on the page as one list, open', async () => {
    const { container } = mount();
    await expectPropertyList(container);  });

  /* The fields are the note's own data, so they are edited where they are read. */
  it('keeps the fields editable in place', async () => {
    const { container } = mount();
    await expectPropertyList(container);

    const code = screen.getByLabelText('Code') as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'T1-WWC-5G839' } });
    await waitFor(() =>
      expect((screen.getByLabelText('Code') as HTMLInputElement).value).toBe('T1-WWC-5G839'),
    );
  });
});

describe('the note details on a desktop', () => {
  beforeEach(() => stubMedia(() => false));

  /* The same list the phone draws, and nothing beside the note: one layout, not two. */
  it('draws the same list above the body, open, with nothing beside the note', async () => {
    const { container } = mount();
    await expectPropertyList(container);  });
});
