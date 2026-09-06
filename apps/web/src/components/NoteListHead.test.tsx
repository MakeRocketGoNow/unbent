import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { NoteListHead } from './NoteListHead.js';

/**
 * The header's two states, and what each one promises.
 *
 * The controls this replaced were all on screen at once, so nothing about them could be
 * hidden by accident. Behind icons, two things can: whether the list is already narrowed,
 * and whether a search is still applied. Both are pinned here, and both are pinned on the
 * *accessible name* rather than on a class — the dot is invisible to a screen reader, so a
 * control that read "Filter notes" either way would leave the one fact worth knowing
 * available to sighted users alone.
 */
const props = {
  count: '30 notes',
  query: '',
  onQuery: () => {},
  searchOpen: false,
  onOpenSearch: () => {},
  onCloseSearch: () => {},
  onOpenFilters: () => {},
  onOpenMenu: () => {},
  filtered: false,
  sortMenu: <button>sort</button>,
  newNote: <button>New</button>,
};

describe('NoteListHead', () => {
  afterEach(cleanup);

  it('shows the count and the controls, closed', () => {
    const { getByText, getByLabelText } = render(<NoteListHead {...props} />);
    expect(getByText('30 notes')).toBeTruthy();
    expect(getByLabelText('Search notes')).toBeTruthy();
    expect(getByLabelText('Filter notes')).toBeTruthy();
    expect(getByText('New')).toBeTruthy();
  });

  it('says in its name that the list is already narrowed', () => {
    const { getByLabelText, container } = render(<NoteListHead {...props} filtered />);
    expect(getByLabelText('Filter notes, filters are active')).toBeTruthy();
    // The dot is the glanceable half, and it is hidden from assistive tech on purpose.
    const dot = container.querySelector('.badge-dot');
    expect(dot).toBeTruthy();
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
  });

  it('gives the whole row to the field once search is open', () => {
    const { container, getByLabelText } = render(<NoteListHead {...props} searchOpen query="derm" />);
    expect((getByLabelText('Search notes') as HTMLInputElement).value).toBe('derm');
    // The icons are gone: a field sharing 375px with four controls cannot be read back.
    expect(container.querySelector('.list-head-actions')).toBeNull();
  });

  /*
   * The whole reason the arrow says "and clear the query": a closed field over a live `q`
   * is a list narrowed by something with nothing on screen to say so.
   */
  it('offers a way out that names the clearing, not just the closing', () => {
    const onCloseSearch = vi.fn();
    const { getByLabelText } = render(
      <NoteListHead {...props} searchOpen query="derm" onCloseSearch={onCloseSearch} />,
    );
    fireEvent.click(getByLabelText('Close search and clear the query'));
    expect(onCloseSearch).toHaveBeenCalled();
  });

  it('leaves the search on Escape, the way the rest of the app does', () => {
    const onCloseSearch = vi.fn();
    const { getByLabelText } = render(
      <NoteListHead {...props} searchOpen query="derm" onCloseSearch={onCloseSearch} />,
    );
    fireEvent.keyDown(getByLabelText('Search notes'), { key: 'Escape' });
    expect(onCloseSearch).toHaveBeenCalled();
  });

  it('hides the sort control while searching, where ranking is the order', () => {
    const { queryByText } = render(<NoteListHead {...props} searchOpen sortMenu={null} />);
    expect(queryByText('sort')).toBeNull();
  });

  it('reports typing so the URL stays the one source of the query', () => {
    const onQuery = vi.fn();
    const { getByLabelText } = render(<NoteListHead {...props} searchOpen onQuery={onQuery} />);
    fireEvent.change(getByLabelText('Search notes'), { target: { value: 'receipts' } });
    expect(onQuery).toHaveBeenCalledWith('receipts');
  });
});
