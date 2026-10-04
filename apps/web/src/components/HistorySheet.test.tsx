import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NoteRevision, NoteRevisionSummary } from '@unbent/shared';
import * as api from '../notes-api.js';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';
import { REVISIONS_KEPT } from '@unbent/shared';
import { describeRevision, HistorySheet, retentionSentence } from './HistorySheet.js';
import { formatRevisionWhen } from './format-when.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  listRevisions: vi.fn(),
  getRevision: vi.fn(),
  clearRevisions: vi.fn(),
}));

// The version's text is drawn by Preview, which has its own tests and wants a PDF worker.
vi.mock('./Preview.js', () => ({
  Preview: ({ markdown }: { markdown: string }) => <div data-testid="preview">{markdown}</div>,
}));

/**
 * The History sheet (MAK-119): a note's earlier versions, one of them read, and put back.
 * jsdom has no modal dialog or `matchMedia`; stubbed as `Sheet.test.tsx` stubs them.
 */
const now = Date.now();
const gutted: NoteRevisionSummary = { id: 3, title: 'Minutes', size: 1204, createdAt: now - 60_000, cause: 'assistant' };
const typed: NoteRevisionSummary = { id: 2, title: 'Minutes (draft)', size: 1, createdAt: now - 3_600_000 };
const whole: NoteRevision = { ...gutted, body: 'Agreed: ship on Friday.' };

function mount(onRestore = vi.fn(async () => {}), onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <HistorySheet open onClose={onClose} noteId="n1" onRestore={onRestore} />
    </QueryClientProvider>,
  );
  return { ...view, onRestore, onClose };
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
});

afterEach(() => {
  cleanup();
  resetConnectivity();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('describeRevision', () => {
  it('says how much text a version holds, and what replaced it when that was not typing', () => {
    expect(describeRevision({ size: 1204 })).toBe(`${(1204).toLocaleString()} characters`);
    expect(describeRevision({ size: 1 })).toBe('1 character');
    expect(describeRevision({ size: 0 })).toBe('Empty');
    expect(describeRevision({ size: 12, cause: 'assistant' })).toBe('Before an assistant’s edit · 12 characters');
    expect(describeRevision({ size: 0, cause: 'restore' })).toBe('Before a restore · Empty');
  });
});

describe('HistorySheet', () => {
  it('lists the versions newest first, each with when and what it is', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([gutted, typed]);
    mount();
    const rows = await screen.findAllByRole('button', { name: /characters?$/ });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain(formatRevisionWhen(gutted.createdAt));
    expect(rows[0]!.textContent).toContain('Before an assistant’s edit');
    expect(rows[1]!.textContent).toContain('1 character');
    expect(api.listRevisions).toHaveBeenCalledWith('n1');
    // And why a version someone expected may not be among them.
    expect(screen.getByText(retentionSentence())).toBeTruthy();
    expect(retentionSentence()).toContain(`The last ${REVISIONS_KEPT} are kept`);
  });

  it('asks for the list only once what was on screen has been saved', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([typed]);
    let saved: () => void = () => {};
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <HistorySheet open onClose={() => {}} noteId="n1" saved={() => new Promise<void>((r) => (saved = r))} onRestore={async () => {}} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(api.listRevisions).not.toHaveBeenCalled();
    expect(screen.getByText('Loading…')).toBeTruthy();
    saved();
    expect(await screen.findByRole('button', { name: /1 character$/ })).toBeTruthy();
  });

  it('opens on Loading again after it has been closed, not on the list it last had', async () => {
    vi.mocked(api.listRevisions).mockResolvedValueOnce([typed]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sheet = (open: boolean) => (
      <QueryClientProvider client={client}>
        <HistorySheet open={open} onClose={() => {}} noteId="n1" onRestore={async () => {}} />
      </QueryClientProvider>
    );
    const view = render(sheet(true));
    await screen.findByRole('button', { name: /1 character$/ });
    view.rerender(sheet(false));
    vi.mocked(api.listRevisions).mockReturnValueOnce(new Promise(() => {}));
    view.rerender(sheet(true));
    await waitFor(() => expect(screen.getByText('Loading…')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /1 character$/ })).toBeNull();
  });

  it('says so when there are none, with the same explanation', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([]);
    mount();
    expect(await screen.findByText('No earlier versions yet.')).toBeTruthy();
    expect(screen.getByText(/A version is kept when/)).toBeTruthy();
  });

  it('offers to try again when the list cannot be read', async () => {
    vi.mocked(api.listRevisions).mockRejectedValueOnce(new Error('503'));
    mount();
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded/);
    vi.mocked(api.listRevisions).mockResolvedValueOnce([typed]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /1 character$/ })).toBeTruthy();
  });

  it('opens a version as its own page, headed by its time, with a way back', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([gutted, typed]);
    vi.mocked(api.getRevision).mockResolvedValue(whole);
    mount();
    fireEvent.click((await screen.findAllByRole('button', { name: /characters?$/ }))[0]!);

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(formatRevisionWhen(gutted.createdAt));
    expect((await screen.findByTestId('preview')).textContent).toBe('Agreed: ship on Friday.');
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Minutes');
    expect(api.getRevision).toHaveBeenCalledWith('n1', 3);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('History');
  });

  it('moves focus with the page: to Back on a version, and to its row on the way back', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([gutted, typed]);
    vi.mocked(api.getRevision).mockResolvedValue(whole);
    mount();
    fireEvent.click((await screen.findAllByRole('button', { name: /characters?$/ }))[1]!);
    const back = screen.getByRole('button', { name: 'Back' });
    await waitFor(() => expect(document.activeElement).toBe(back));
    fireEvent.click(back);
    await waitFor(() => expect(document.activeElement?.textContent).toContain('1 character'));
  });

  it('fades what needs the server when the connection goes while it is open', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([gutted]);
    vi.mocked(api.getRevision).mockResolvedValue(whole);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /characters$/ }));
    await screen.findByTestId('preview');
    const restore = screen.getByRole<HTMLButtonElement>('button', { name: 'Restore this version' });
    expect(restore.disabled).toBe(false);
    act(() => setReachableForTests(false));
    await waitFor(() => expect(restore.disabled).toBe(true));
    expect(restore.title).toBe('Not available offline');
  });

  it('does not offer Restore until the version has loaded', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([gutted]);
    let land: (r: NoteRevision) => void = () => {};
    vi.mocked(api.getRevision).mockReturnValue(new Promise((r) => (land = r)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /characters$/ }));
    const restore = screen.getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    land(whole);
    await waitFor(() => expect(restore.disabled).toBe(false));
  });

  it('hands the version to its caller on Restore, and says why that is safe', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([gutted]);
    vi.mocked(api.getRevision).mockResolvedValue(whole);
    const { onRestore } = mount();
    fireEvent.click(await screen.findByRole('button', { name: /characters$/ }));
    await screen.findByTestId('preview');
    expect(screen.getByText(/kept in History, so this can be undone/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(gutted));
  });

  it('stays on the version and says what went wrong when the restore is refused', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([gutted]);
    vi.mocked(api.getRevision).mockResolvedValue(whole);
    const onRestore = vi.fn(async () => {
      throw new Error('This note has changes that have not synced yet. Try again in a moment.');
    });
    mount(onRestore);
    fireEvent.click(await screen.findByRole('button', { name: /characters$/ }));
    await screen.findByTestId('preview');
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not synced yet/);
    expect(screen.getByTestId('preview')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says a version with no text is empty rather than drawing nothing', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([{ ...typed, size: 0 }]);
    vi.mocked(api.getRevision).mockResolvedValue({ ...typed, size: 0, body: '' });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Empty$/ }));
    expect(await screen.findByText('This version had no text.')).toBeTruthy();
  });

  it('clears the history only after asking, naming how many versions go and that the note stays', async () => {
    vi.mocked(api.listRevisions).mockResolvedValueOnce([gutted, typed]);
    vi.mocked(api.clearRevisions).mockResolvedValue(2);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear history' }));
    expect(api.clearRevisions).not.toHaveBeenCalled();

    const confirm = screen.getByRole('group', { name: 'Confirm clear history' });
    expect(confirm.textContent).toContain('All 2 earlier versions are deleted for good');
    expect(confirm.textContent).toContain('The note itself is not changed.');
    // Red, as every confirm of something that cannot be taken back is.
    expect(confirm.className).toContain('confirm-danger');

    vi.mocked(api.listRevisions).mockResolvedValueOnce([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(api.clearRevisions).toHaveBeenCalledWith('n1'));
    expect(await screen.findByText('No earlier versions yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear history' })).toBeNull();
  });

  it('leaves the history alone on Cancel', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([gutted]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.clearRevisions).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Clear history' })).toBeTruthy();
  });

  it('keeps the question open and says why when the clear is refused', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([gutted]);
    vi.mocked(api.clearRevisions).mockRejectedValueOnce(new Error('503 Service Unavailable: The server is busy'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear history' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm clear history' })).getByRole('button', { name: 'Clear history' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The server is busy');
    expect(screen.getByRole('group', { name: 'Confirm clear history' })).toBeTruthy();
  });

  it('has nothing to clear when there are no versions', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue([]);
    mount();
    await screen.findByText('No earlier versions yet.');
    expect(screen.queryByRole('button', { name: 'Clear history' })).toBeNull();
  });
});
