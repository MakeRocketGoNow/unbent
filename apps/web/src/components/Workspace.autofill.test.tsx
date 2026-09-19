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
import type { AutofillSuggestion, FieldDef, Note } from '@unbent/shared';
import * as api from '../notes-api.js';
import { keys } from '../queries.js';
import { Workspace } from './Workspace.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  autofillNote: vi.fn(),
  updateNote: vi.fn(),
}));

/**
 * The Auto-fill control: drawn only where the instance can answer, and applying what
 * comes back the way `autofill.ts` plans it — empties filled at once, anything already
 * set offered for replacement first.
 */
const amount: FieldDef = {
  id: 'f-amount',
  notebookId: 'nb-receipts',
  name: 'Amount',
  type: 'number',
  options: [],
  scale: null,
  currency: 'USD',
  position: 0,
};

const suggestion: AutofillSuggestion = {
  title: { value: 'Acme Hardware', confidence: 0.8 },
  notebook: { id: 'nb-receipts', name: 'Receipts', confidence: 0.9 },
  tags: [{ name: 'home', confidence: 0.9 }],
  fields: [{ field: amount, value: 12.5, confidence: 0.9 }],
  read: { attachments: ['scan.pdf'], pending: [] },
};

function mount(note: Note, config: { autofill?: boolean } = { autofill: true }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.note(note.id), note);
  client.setQueryData(keys.attachments(note.id), []);
  client.setQueryData(keys.tags(), []);
  client.setQueryData(keys.config(), { providers: [], ...config });
  client.setQueryData(keys.notebooks(), {
    notebooks: [
      { id: 'nb-coupons', name: 'Coupons', count: 1, fields: 0 },
      { id: 'nb-receipts', name: 'Receipts', count: 3, fields: 1 },
    ],
    unfiled: 1,
  });
  client.setQueryData(keys.notebookFields('nb-receipts'), [amount]);
  client.setQueryData(keys.notebookFields('nb-coupons'), []);
  vi.mocked(api.updateNote).mockImplementation(async (id, patch) => ({ ...note, id, ...patch } as Note));

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

const fresh: Note = {
  id: 'n1',
  title: '',
  body: '',
  tags: [],
  notebook: null,
  createdAt: 0,
  updatedAt: 0,
  fields: [],
};

/** jsdom has neither; the workspace asks both on mount. The details test stubs them the same way. */
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
});

describe('the Auto-fill control', () => {
  it('is drawn only where the instance can answer', async () => {
    mount(fresh, {});
    await screen.findByPlaceholderText('Untitled');
    expect(screen.queryByRole('button', { name: 'Auto-fill' })).toBeNull();
    cleanup();

    mount(fresh);
    await screen.findByPlaceholderText('Untitled');
    expect(screen.getByRole('button', { name: 'Auto-fill' })).toBeTruthy();
  });

  it('fills an empty note at once and says what it filled', async () => {
    vi.mocked(api.autofillNote).mockResolvedValue(suggestion);
    mount(fresh);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));

    await waitFor(() => expect(api.autofillNote).toHaveBeenCalledWith('n1'));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Acme Hardware'),
    );
    expect((screen.getByLabelText('Notebook') as unknown as HTMLSelectElement).value).toBe('Receipts');
    expect(document.querySelector('.tag-input')?.textContent).toContain('home');
    // The suggested notebook's field, with the value, once its definitions are on screen.
    await waitFor(() => expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('12.5'));
    expect(screen.getByText('Filled in the title, the notebook, a tag and Amount')).toBeTruthy();
    expect(document.querySelector('.confirm')).toBeNull();
  });

  it('asks before replacing what is already set, and fills the rest meanwhile', async () => {
    vi.mocked(api.autofillNote).mockResolvedValue(suggestion);
    mount({ ...fresh, title: 'My own title', notebook: 'Receipts' });
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));

    const confirm = await screen.findByRole('group', { name: "Confirm replacing the note's filing" });
    expect(confirm.textContent).toContain('Also replace the title?');
    expect(confirm.textContent).toContain('Title: Acme Hardware');
    // The title is kept until asked; the tag and the field were empty, so they landed.
    expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('My own title');
    expect(document.querySelector('.tag-input')?.textContent).toContain('home');
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('12.5');

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Acme Hardware');
    expect(document.querySelector('.confirm')).toBeNull();
  });

  it('shows the server’s sentence when there is nothing to read', async () => {
    vi.mocked(api.autofillNote).mockRejectedValue(
      new api.ApiError(422, '422: Nothing to read yet: scan.pdf is still being read. Try again in a moment.'),
    );
    mount(fresh);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    const status = await screen.findByText(/still being read/);
    expect(status.textContent).not.toMatch(/^422/);
    expect(status.className).toContain('bad');
  });
});
