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
import type { AttachmentInfo, AutofillSuggestion, FieldDef, Note } from '@unbent/shared';
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
 * comes back the way `autofill.ts` plans it: empties filled at once, anything already
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

function seedNote(client: QueryClient, note: Note, files: AttachmentInfo[] = []) {
  client.setQueryData(keys.note(note.id), note);
  client.setQueryData(keys.attachments(note.id), files);
}

function mount(
  note: Note,
  config: { autofill?: boolean } = { autofill: true },
  others: Note[] = [],
  files: AttachmentInfo[] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seedNote(client, note, files);
  for (const other of others) seedNote(client, other);
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
  vi.mocked(api.updateNote).mockImplementation(async (id, patch) => {
    const current = client.getQueryData<Note>(keys.note(id));
    return { ...(current ?? note), id, ...patch } as Note;
  });

  /*
     Workspace is reused across notes in the app (a new `noteId` prop, not a remount)
     and Auto-fill's round trip is long enough that arrowing to the next note meanwhile
     is the ordinary thing. The harness switches the same way so the tests can watch
     a suggestion for one note try to land on another.
  */
  function Harness() {
    const [id, setId] = useState(note.id);
    return (
      <>
        {others.map((other) => (
          <button key={other.id} type="button" onClick={() => setId(other.id)}>
            Open {other.id}
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

/** A second note already filed, so a suggestion for `fresh` landing here is visible. */
const other: Note = {
  id: 'n2',
  title: 'Weekly review',
  body: 'already written',
  tags: ['work'],
  notebook: 'Coupons',
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
    await waitFor(() => expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('12.50'));
    expect(screen.getByText('Filled in the title, the notebook, a tag and Amount')).toBeTruthy();
    expect(document.querySelector('.confirm')).toBeNull();
  });

  /*
   * Where the press wrote, marked for a moment: each thing it filled carries its place in
   * one sequence down the record, which the stylesheet staggers; Undo takes the marks with
   * the fill.
   */
  it('marks what it filled where it landed, in order down the record', async () => {
    vi.mocked(api.autofillNote).mockResolvedValue(suggestion);
    mount(fresh);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    await waitFor(() => expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('12.50'));

    const place = (el: Element | null | undefined) => (el as HTMLElement | null)?.style.getPropertyValue('--filled-i');
    const title = screen.getByPlaceholderText('Untitled');
    expect(title.classList.contains('filled-title')).toBe(true);
    expect(place(title)).toBe('0');
    const notebookRow = screen.getByLabelText('Notebook').closest('.note-field');
    expect(notebookRow?.classList.contains('filled')).toBe(true);
    expect(place(notebookRow)).toBe('1');
    const chip = [...document.querySelectorAll('.tag-chip')].find((c) => c.textContent?.includes('home'));
    expect(chip?.classList.contains('fresh')).toBe(true);
    expect(place(chip)).toBe('2');
    const amountRow = screen.getByLabelText('Amount').closest('.note-field');
    expect(amountRow?.classList.contains('filled')).toBe(true);
    expect(place(amountRow)).toBe('3');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(document.querySelector('.filled, .filled-title, .filled-tags, .fresh')).toBeNull();
  });

  it('marks what a replace wrote once it is confirmed, and nothing before', async () => {
    vi.mocked(api.autofillNote).mockResolvedValue(suggestion);
    mount({ ...fresh, title: 'My own title', notebook: 'Receipts' });
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    await screen.findByRole('group', { name: "Confirm replacing the note's filing" });
    expect(screen.getByPlaceholderText('Untitled').classList.contains('filled-title')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(screen.getByPlaceholderText('Untitled').classList.contains('filled-title')).toBe(true);
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
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('12.50');

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Acme Hardware');
    expect(document.querySelector('.confirm')).toBeNull();
  });

  it('names the file it could not read beside what it filled', async () => {
    vi.mocked(api.autofillNote).mockResolvedValue({
      ...suggestion,
      read: { attachments: ['scan.pdf'], pending: ['back.pdf'] },
    });
    mount(fresh);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    expect(
      await screen.findByText("Filled in the title, the notebook, a tag and Amount; couldn't read back.pdf"),
    ).toBeTruthy();
  });

  it('counts the files it could not read when there are several', async () => {
    vi.mocked(api.autofillNote).mockResolvedValue({
      ...suggestion,
      read: { attachments: [], pending: ['a.pdf', 'b.pdf'] },
    });
    mount(fresh);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    expect(await screen.findByText(/; couldn't read 2 files$/)).toBeTruthy();
  });

  it('shows the server’s sentence when there is nothing to read', async () => {
    vi.mocked(api.autofillNote).mockRejectedValue(
      new api.ApiError(422, "422: Couldn't read scan.pdf, so there's nothing to fill in from. Try again later."),
    );
    mount(fresh);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    const message = await screen.findByText(/couldn't read scan\.pdf/i);
    expect(message.textContent).not.toMatch(/^422/);
    // An error rides in the snackbar's error tone, and stays until dismissed rather than
    // fading, so there is a close button and no auto-clear.
    const snackbar = message.closest('.snackbar');
    expect(snackbar?.className).toContain('error');
    expect(snackbar?.querySelector('.snackbar-action')).toBeNull();
    expect(snackbar?.querySelector('[aria-label="Dismiss notification"]')).toBeTruthy();
  });

  it('shows the server\u2019s sentence when the day\u2019s presses are used up', async () => {
    // MAK-180: past the instance's daily cap the press is a 429 whose sentence says when it
    // works again. It is shown as the server wrote it, like any other refusal.
    const sentence = "Auto-fill can be used 50 times a day on this instance, and today's are used up. It will work again in 6 hours.";
    vi.mocked(api.autofillNote).mockRejectedValue(new api.ApiError(429, `429: ${sentence}`));
    mount(fresh);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    const message = await screen.findByText(sentence);
    expect(message.closest('.snackbar')?.className).toContain('error');
    // The button is free again for a later press, not left busy.
    expect((await screen.findByRole('button', { name: 'Auto-fill' })).hasAttribute('disabled')).toBe(false);
  });

  it('offers Undo after a fill and restores what it changed', async () => {
    vi.mocked(api.autofillNote).mockResolvedValue(suggestion);
    mount(fresh);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Acme Hardware'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    // The whole fill comes back out as one edit: the title it set is empty again.
    expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText(/Filled in/)).toBeNull();
  });

  it('fills a scanner-titled note without asking to replace the title', async () => {
    vi.mocked(api.autofillNote).mockResolvedValue(suggestion);
    // What a ScanSnap scan lands as: a timestamp for a title, not one anyone chose.
    mount({ ...fresh, title: '2026_09_18_15_38_48' });
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));

    await waitFor(() =>
      expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Acme Hardware'),
    );
    // No "Also replace the title?" for a placeholder title: it just fills.
    expect(screen.queryByRole('group', { name: "Confirm replacing the note's filing" })).toBeNull();
    expect(screen.getByText(/Filled in the title/)).toBeTruthy();
  });

  it('fills a note titled after its own file without asking, whatever the device named it', async () => {
    vi.mocked(api.autofillNote).mockResolvedValue(suggestion);
    // A phone's scanner: no timestamp shape the rule knows, only the file's own name.
    mount({ ...fresh, title: 'Scanned_20250311-0942' }, { autofill: true }, [], [
      { filename: 'Scanned_20250311-0942.pdf', contentType: 'application/pdf', size: 1024 },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));

    await waitFor(() =>
      expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Acme Hardware'),
    );
    expect(screen.queryByRole('group', { name: "Confirm replacing the note's filing" })).toBeNull();
  });

  it('shows a dismissible operator notice when the title model rejected its key', async () => {
    // The server only sends `titleModel` to an operator; the client trusts and shows it.
    vi.mocked(api.autofillNote).mockResolvedValue({ ...suggestion, titleModel: 'auth-failed' });
    mount(fresh);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));

    const notice = await screen.findByText(/rejected the API key/);
    expect(notice.textContent).toContain('ANTHROPIC_API_KEY');
    // The fill still succeeded: the notice rides alongside a filled title, not instead of it.
    expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Acme Hardware');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/rejected the API key/)).toBeNull();
  });

  it('shows no operator notice when the suggestion does not carry one', async () => {
    vi.mocked(api.autofillNote).mockResolvedValue(suggestion);
    mount(fresh);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    await waitFor(() => expect(api.autofillNote).toHaveBeenCalledWith('n1'));
    expect(document.querySelector('.operator-notice')).toBeNull();
  });

  it('does not file the next note when Auto-fill’s answer arrives after a switch', async () => {
    let finish: (value: AutofillSuggestion) => void = () => {};
    vi.mocked(api.autofillNote).mockImplementation(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    mount(fresh, { autofill: true }, [other]);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    await waitFor(() => expect(api.autofillNote).toHaveBeenCalledWith('n1'));
    expect(screen.getByText('Reading…')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open n2' }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Weekly review'),
    );

    finish(suggestion);
    // The suggestion's continuation is a microtask. Flush it (and the render it would
    // cause) so a landing on this note would already be visible before we assert it
    // did not.
    await act(async () => {
      await Promise.resolve();
    });
    expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Weekly review');
    expect((screen.getByLabelText('Notebook') as unknown as HTMLSelectElement).value).toBe('Coupons');
    expect(document.querySelector('.tag-input')?.textContent).toContain('work');
    expect(document.querySelector('.tag-input')?.textContent).not.toContain('home');
    expect(screen.queryByLabelText('Amount')).toBeNull();
    expect(screen.queryByText(/Filled in/)).toBeNull();
    expect(screen.queryByRole('group', { name: "Confirm replacing the note's filing" })).toBeNull();
  });

  it('drops a replace confirm when the open note changes', async () => {
    vi.mocked(api.autofillNote).mockResolvedValue(suggestion);
    mount({ ...fresh, title: 'My own title', notebook: 'Receipts' }, { autofill: true }, [other]);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-fill' }));
    expect(await screen.findByRole('group', { name: "Confirm replacing the note's filing" })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open n2' }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Weekly review'),
    );
    expect(screen.queryByRole('group', { name: "Confirm replacing the note's filing" })).toBeNull();
    expect((screen.getByPlaceholderText('Untitled') as HTMLInputElement).value).toBe('Weekly review');
  });
});
