import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotePicker } from './NotePicker.js';

/**
 * Choosing a note to send a file to. What matters: it opens on recent notes with the
 * current one left out, typing switches to the app's search, and a row hands back the
 * note it names.
 */
vi.mock('../notes-api.js', () => ({
  listNotes: vi.fn(),
  searchNotes: vi.fn(),
}));

import * as api from '../notes-api.js';

const HERE = 'note-here';
const recent = [
  { id: HERE, title: 'This one', updatedAt: 1 },
  { id: 'n1', title: 'Coupons', updatedAt: 2 },
  { id: 'n2', title: '', updatedAt: 3 },
];

function harness(props: Partial<Parameters<typeof NotePicker>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPick = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <NotePicker label="Copy to note" excludeId={HERE} onPick={onPick} onCancel={onCancel} {...props} />
    </QueryClientProvider>,
  );
  return { ...utils, onPick, onCancel };
}

const titles = (c: HTMLElement) =>
  [...c.querySelectorAll('.note-picker-title')].map((e) => e.textContent);

describe('NotePicker', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens on recent notes, without the note it was opened from', async () => {
    vi.mocked(api.listNotes).mockResolvedValue({ items: recent as never, cursor: null, total: 3 });
    const { container } = harness();
    await waitFor(() => expect(titles(container)).toEqual(['Coupons', 'Untitled']));
    expect(api.searchNotes).not.toHaveBeenCalled();
  });

  it('searches once something is typed, and hands back the chosen note', async () => {
    vi.mocked(api.listNotes).mockResolvedValue({ items: [], cursor: null, total: 0 });
    vi.mocked(api.searchNotes).mockResolvedValue([
      { id: 'n9', title: 'Podcast Bookmarks', updatedAt: 9, snippet: '' },
    ]);
    const { container, getByLabelText, onPick } = harness();
    fireEvent.change(getByLabelText('Find a note'), { target: { value: 'pod' } });
    await waitFor(() => expect(titles(container)).toEqual(['Podcast Bookmarks']));
    expect(api.searchNotes).toHaveBeenCalledWith('pod');

    fireEvent.click(container.querySelector('.note-picker-item')!);
    expect(onPick).toHaveBeenCalledWith({ id: 'n9', title: 'Podcast Bookmarks', updatedAt: 9 });
  });

  it('cancels on Escape and on the button', async () => {
    vi.mocked(api.listNotes).mockResolvedValue({ items: [], cursor: null, total: 0 });
    const { getByLabelText, getByText, onCancel } = harness();
    fireEvent.keyDown(getByLabelText('Find a note'), { key: 'Escape' });
    fireEvent.click(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
