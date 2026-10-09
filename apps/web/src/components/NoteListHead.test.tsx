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
  title: 'All notes',
  query: '',
  onQuery: () => {},
  searchOpen: false,
  onOpenSearch: () => {},
  onCloseSearch: () => {},
  onOpenFilters: () => {},
  onOpenMenu: () => {},
  filtered: false,
  sort: <button>more</button>,
};

describe('NoteListHead', () => {
  afterEach(cleanup);

  it('says where the list is and how much of it there is', () => {
    const { getByText, getByLabelText } = render(
      <NoteListHead {...props} title="Coupons" count="12 notes" />,
    );
    // The heading this view did not have: the count alone said how many without ever
    // saying of what.
    expect(getByText('Coupons').tagName).toBe('H2');
    expect(getByText('12 notes')).toBeTruthy();
    expect(getByLabelText('Notebooks')).toBeTruthy();
    expect(getByLabelText('Search notes')).toBeTruthy();
    expect(getByLabelText('Filter notes')).toBeTruthy();
  });

  /* A narrowed list's count is how it is exported, at every width and in every view; an
     unfiltered one stays plain text, since its export is the whole library's page. */
  it('makes the count a menu only when given one', () => {
    const onExport = vi.fn();
    const { getByRole, getByText, queryByRole, rerender } = render(
      <NoteListHead
        {...props}
        count="37 notes"
        countMenu={[{ label: 'Export these 37 notes', onSelect: onExport }]}
      />,
    );
    const trigger = getByRole('button', { name: '37 notes, export or select' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('true');
    fireEvent.click(trigger);
    fireEvent.click(getByText('Export these 37 notes'));
    expect(onExport).toHaveBeenCalledOnce();

    rerender(<NoteListHead {...props} count="37 notes" />);
    expect(queryByRole('button', { name: /37 notes/ })).toBeNull();
    expect(getByText('37 notes').tagName).toBe('SPAN');
  });

  it('keeps an unknown count plain even with a menu to offer', () => {
    const { queryByRole } = render(
      <NoteListHead {...props} count={null} countMenu={[{ label: 'Export', onSelect: () => {} }]} />,
    );
    expect(queryByRole('button', { name: /export or select/ })).toBeNull();
  });

  /* New floats over the list now, where every notes app people arrive from puts it, so
     this row is only the controls that are about what is already on screen. */
  it('draws the view toggle between the sort and the action', () => {
    const { container } = render(
      <NoteListHead
        {...props}
        onOpenMenu={undefined}
        view={<span data-testid="view">view</span>}
        action={<button>New</button>}
      />,
    );
    const actions = container.querySelector('.list-head-actions')!;
    const order = [...actions.children].map((el) => el.textContent);
    expect(order.slice(-3)).toEqual(['more', 'view', 'New']);
  });

  /* Over the full-width table the header is one row: picker, count, search, controls.
     The search field must move into that row, not be drawn a second time under it. */
  it('draws one toolbar row holding the title and the search field', () => {
    const { container, getAllByLabelText } = render(
      <NoteListHead {...props} title="Travel" onOpenMenu={undefined} onOpenSearch={undefined} toolbar />,
    );
    const row = container.querySelector('.list-head-toolbar')!;
    expect([...row.children].map((el) => el.className)).toEqual([
      'list-title',
      'list-search',
      'list-head-actions',
    ]);
    expect(row.querySelector('h2')?.textContent).toBe('Travel');
    expect(getAllByLabelText('Search notes')).toHaveLength(1);
    expect(container.querySelectorAll('.list-search')).toHaveLength(1);
  });

  /* Typing in the table's toolbar leaves the table — results are a list — which swaps
     this header's layout under the caret. The field is a new element; focus must follow. */
  it('keeps focus in the search field when the layout changes under it', () => {
    const base = { ...props, onOpenMenu: undefined, onOpenSearch: undefined };
    const { getByLabelText, rerender } = render(<NoteListHead {...base} toolbar />);
    const before = getByLabelText('Search notes');
    before.focus();
    rerender(<NoteListHead {...base} query="s" />);
    const after = getByLabelText('Search notes');
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
  });

  it('keeps the stacked header when the toolbar is not asked for', () => {
    const { container } = render(<NoteListHead {...props} onOpenSearch={undefined} />);
    expect(container.querySelector('.list-head-toolbar')).toBeNull();
    expect(container.querySelector('.list-head + .list-search')).toBeTruthy();
  });

  it('leaves making a note to the floating button', () => {
    const { queryByText } = render(<NoteListHead {...props} />);
    expect(queryByText('New')).toBeNull();
  });

  it('says in its name that the list is already narrowed', () => {
    const { getByLabelText, container } = render(<NoteListHead {...props} filtered />);
    expect(getByLabelText('Filter notes, filters are active')).toBeTruthy();
    // The dot is the glanceable half, and it is hidden from assistive tech on purpose.
    const dot = container.querySelector('.badge-dot');
    expect(dot).toBeTruthy();
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
  });

  /*
   * The count is not carried into the search row, and that is the point.
   *
   * It was, on a second line under the field, which made the open row taller than the
   * closed header and pushed the whole note list down on every search. The results are the
   * answer to a search and they are already on screen; a count earns a line when it
   * describes something you cannot see all of.
   */
  it('does not carry the count into the search row, which kept the list from shifting', () => {
    const { queryByText } = render(
      <NoteListHead {...props} searchOpen query="derm" count="6 matches" />,
    );
    expect(queryByText('6 matches')).toBeNull();
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

  /* The whole action row goes while searching, the sort slot included — the caller
     already passes nothing there, and the row must not leave an empty corner behind. */
  it('puts the actions away while the field has the row', () => {
    const { queryByText } = render(<NoteListHead {...props} searchOpen />);
    expect(queryByText('more')).toBeNull();
  });

  /* Down from the field goes to the results — the list under it is what typing produced. */
  it('hands Arrow Down to the caller, which enters the list', () => {
    const onArrowDown = vi.fn();
    const { getByLabelText } = render(
      <NoteListHead {...props} searchOpen query="derm" onArrowDown={onArrowDown} />,
    );
    const prevented = !fireEvent.keyDown(getByLabelText('Search notes'), { key: 'ArrowDown' });
    expect(onArrowDown).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it('reports typing so the URL stays the one source of the query', () => {
    const onQuery = vi.fn();
    const { getByLabelText } = render(<NoteListHead {...props} searchOpen onQuery={onQuery} />);
    fireEvent.change(getByLabelText('Search notes'), { target: { value: 'receipts' } });
    expect(onQuery).toHaveBeenCalledWith('receipts');
  });

  /*
   * The desktop's shape, which is the same row with two props withheld and one added.
   *
   * No `onOpenSearch` means the field is not behind an icon: it is a permanent row under
   * the header, because a desktop column has the width for the one control used on most
   * visits. No `onOpenMenu`, because the notebooks are a rail beside the column rather
   * than a drawer behind a button. `action` is the desktop's New, at the end of the row.
   */
  describe('at desktop width', () => {
    const desktop = {
      ...props,
      onOpenSearch: undefined,
      onOpenMenu: undefined,
      action: <button>New</button>,
    };

    it('keeps the field on screen beside the controls', () => {
      const { container, getByLabelText, queryByLabelText } = render(
        <NoteListHead {...desktop} query="derm" />,
      );
      expect((getByLabelText('Search notes') as HTMLInputElement).value).toBe('derm');
      expect(container.querySelector('.list-head-actions')).toBeTruthy();
      // Nothing to open, so nothing to close: the arrow is a phone control.
      expect(queryByLabelText('Close search and clear the query')).toBeNull();
    });

    it('ignores the phone\'s open state, since there is nothing to open', () => {
      const { container } = render(<NoteListHead {...desktop} searchOpen />);
      expect(container.querySelector('.list-head-actions')).toBeTruthy();
    });

    /* The heading stays: the rail beside the column can be a strip of icons, so the
       column has to say what it holds on its own. */
    it('has no drawer button, and keeps the heading and the count', () => {
      const { container, queryByLabelText, getByText } = render(<NoteListHead {...desktop} />);
      expect(queryByLabelText('Notebooks')).toBeNull();
      expect(container.querySelector('h2')?.textContent).toBe('All notes');
      expect(container.querySelector('h2')?.getAttribute('title')).toBe('All notes');
      expect(getByText('30 notes')).toBeTruthy();
    });

    it('puts the action after the controls', () => {
      const { container } = render(<NoteListHead {...desktop} />);
      const actions = container.querySelector('.list-head-actions') as HTMLElement;
      const labels = [...actions.querySelectorAll('button')].map(
        (b) => b.getAttribute('aria-label') ?? b.textContent,
      );
      expect(labels).toEqual(['Filter notes', 'more', 'New']);
    });

    it('clears on Escape, the one thing Escape can mean for a field that stays', () => {
      const onCloseSearch = vi.fn();
      const { getByLabelText } = render(
        <NoteListHead {...desktop} query="derm" onCloseSearch={onCloseSearch} />,
      );
      fireEvent.keyDown(getByLabelText('Search notes'), { key: 'Escape' });
      expect(onCloseSearch).toHaveBeenCalled();
    });
  });
});
