import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import {
  useListKeys,
  useCameFromList,
  registerEditorFocus,
  focusActiveListItem,
  enterList,
} from './useListKeys.js';

/**
 * Arrow-key navigation over the sidebar list.
 *
 * The entries are rendered as plain anchors rather than through the router: what is under
 * test is which element ends up focused and whether the entry was activated, and a real
 * `Link` would drag in a router, a query client and the note endpoints to prove the same
 * thing. If the markup moves, this is a reminder to keep `.note-item` as the hook's hook.
 */
function List({ onActivate }: { onActivate?: (id: string) => void }) {
  const onKeyDown = useListKeys();
  const cameFromList = useCameFromList();
  return (
    <div>
      <span data-testid="flag">{String(cameFromList)}</span>
      <ul className="note-list" onKeyDown={onKeyDown}>
        {['a', 'b', 'c'].map((id) => (
          <li key={id}>
            <a href={`#${id}`} className="note-item" data-testid={id} onClick={() => onActivate?.(id)}>
              {id}
            </a>
          </li>
        ))}
        <li>
          <button type="button" data-testid="more">Load more</button>
        </li>
      </ul>
    </div>
  );
}

/**
 * A side-by-side list: its rows carry `data-keep-focus`, so clicking one is browsing and
 * the flag it sets is `true`, the same as arrowing to it.
 */
function DesktopList() {
  const cameFromList = useCameFromList();
  return (
    <div>
      <span data-testid="flag">{String(cameFromList)}</span>
      <ul className="note-list">
        <li>
          <a href="#a" className="note-item" data-keep-focus="" data-testid="desktop">
            a
          </a>
        </li>
      </ul>
    </div>
  );
}

afterEach(() => {
  cleanup();
  registerEditorFocus(null);
  // The flag lives at module scope, so it outlives a test unless it is put back.
  fireEvent.pointerDown(document.body);
});

describe('useListKeys', () => {
  it('moves focus to the next and previous entry', () => {
    render(<List />);
    screen.getByTestId('a').focus();

    fireEvent.keyDown(screen.getByRole('list'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('b'));

    fireEvent.keyDown(screen.getByRole('list'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('a'));
  });

  /* Focusing a link is not opening it; the click is what routes. */
  it('opens the entry it moves to', () => {
    const onActivate = vi.fn();
    render(<List onActivate={onActivate} />);
    screen.getByTestId('a').focus();

    fireEvent.keyDown(screen.getByRole('list'), { key: 'ArrowDown' });
    expect(onActivate).toHaveBeenCalledWith('b');
  });

  /*
     At either end the key is left alone, so the browser scrolls the sidebar rather than
     the selection silently refusing to move.
  */
  it('stops at the ends without preventing the key', () => {
    render(<List />);
    screen.getByTestId('a').focus();

    const atTop = fireEvent.keyDown(screen.getByRole('list'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('a'));
    expect(atTop).toBe(true); // not prevented

    screen.getByTestId('c').focus();
    fireEvent.keyDown(screen.getByRole('list'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('c'));
  });

  /* A row that has just left stays drawn while it closes up (`list-motion.ts`); it is not a row. */
  it('passes over the copy of a row that has just left the list', () => {
    const onActivate = vi.fn();
    render(<List onActivate={onActivate} />);
    const copy = document.createElement('li');
    copy.className = 'note-entry note-ghost';
    copy.innerHTML = '<a class="note-item active" data-testid="copy">gone</a>';
    screen.getByRole('list').appendChild(copy);

    screen.getByTestId('c').focus();
    fireEvent.keyDown(screen.getByRole('list'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('c'));
    expect(focusActiveListItem()).toBe(false);
  });

  /* Arrows inside other controls in the same list belong to those controls. */
  it('ignores arrows when an entry is not focused', () => {
    render(<List />);
    screen.getByTestId('more').focus();

    fireEvent.keyDown(screen.getByRole('list'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('more'));
  });

  it('reports that the keyboard is driving, and stops on a pointer press', () => {
    render(<List />);
    screen.getByTestId('a').focus();
    expect(screen.getByTestId('flag').textContent).toBe('false');

    fireEvent.keyDown(screen.getByRole('list'), { key: 'ArrowDown' });
    expect(screen.getByTestId('flag').textContent).toBe('true');

    // A click on a phone row (one whose list is replaced by the note) opens the editor,
    // so it must not inherit the arrow keys' keep-focus rule.
    fireEvent.pointerDown(screen.getByTestId('c'));
    expect(screen.getByTestId('flag').textContent).toBe('false');
  });

  /*
     Clicking a note in a side-by-side list is browsing: the row keeps focus and the editor
     stands down, the same as arrowing to it. The row says so with `data-keep-focus`.
  */
  it('keeps focus on the row when a side-by-side note is clicked', () => {
    render(<DesktopList />);
    fireEvent.pointerDown(screen.getByTestId('desktop'));
    expect(screen.getByTestId('flag').textContent).toBe('true');

    // A press outside any note (the editor, the New button) still opens ready to type.
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('flag').textContent).toBe('false');
  });

  it('hands focus to the editor on Enter', () => {
    const focus = vi.fn();
    registerEditorFocus(focus);
    render(<List />);
    screen.getByTestId('a').focus();
    fireEvent.keyDown(screen.getByRole('list'), { key: 'ArrowDown' });

    fireEvent.keyDown(screen.getByRole('list'), { key: 'Enter' });
    expect(focus).toHaveBeenCalled();
    // The editor now owns focus, so a later mount must be allowed to take it.
    expect(screen.getByTestId('flag').textContent).toBe('false');
  });
});

/**
 * The same list drawn as a table: the rows are `<tr>`s whose name cell holds the link.
 * The keys must browse those links exactly as they browse sidebar entries, and a press
 * anywhere on a row (not only on its link) is browsing.
 */
function Table({ onActivate }: { onActivate?: (id: string) => void }) {
  const onKeyDown = useListKeys();
  const cameFromList = useCameFromList();
  return (
    <div>
      <span data-testid="flag">{String(cameFromList)}</span>
      <div className="note-table-wrap" onKeyDown={onKeyDown} data-testid="table">
        <table>
          <tbody>
            {['a', 'b'].map((id) => (
              <tr key={id} className="note-row" data-keep-focus="">
                <td>
                  <a
                    href={`#${id}`}
                    className={id === 'b' ? 'note-row-link active' : 'note-row-link'}
                    data-testid={id}
                    onClick={() => onActivate?.(id)}
                  >
                    {id}
                  </a>
                </td>
                <td data-testid={`cell-${id}`}>
                  <input type="checkbox" aria-label={`Packed for ${id}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

describe('useListKeys over the table', () => {
  afterEach(cleanup);

  it('browses the rows by their name links, opening each as it is reached', () => {
    const onActivate = vi.fn();
    render(<Table onActivate={onActivate} />);
    // Called directly rather than through an event, so the flag's re-render is wrapped.
    act(() => {
      expect(enterList(screen.getByTestId('table'))).toBe(true);
    });
    expect(document.activeElement).toBe(screen.getByTestId('a'));
    expect(onActivate).toHaveBeenCalledWith('a');

    fireEvent.keyDown(screen.getByTestId('table'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('b'));
    expect(onActivate).toHaveBeenCalledWith('b');
    expect(screen.getByTestId('flag').textContent).toBe('true');
  });

  it('treats a press anywhere on a row as browsing', () => {
    render(<Table />);
    fireEvent.pointerDown(screen.getByTestId('cell-a'));
    expect(screen.getByTestId('flag').textContent).toBe('true');
  });

  it('puts focus back on the open row', () => {
    render(<Table />);
    expect(focusActiveListItem()).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('b'));
  });
});

describe('focusActiveListItem', () => {
  it('focuses the open note, and reports when there is none', () => {
    expect(focusActiveListItem()).toBe(false);

    render(
      <ul className="note-list">
        <li><a href="#a" className="note-item" data-testid="a">a</a></li>
        <li><a href="#b" className="note-item active" data-testid="b">b</a></li>
      </ul>,
    );
    expect(focusActiveListItem()).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('b'));
  });
});

/**
 * The search's picks are rows too, and the field above is where the list is entered from.
 *
 * A pick is a button: arrowing onto it focuses it and nothing more, because applying a
 * filter is not something a glance should do, and Enter presses it. A note is opened as
 * it is reached, as before. Up from the first row goes back to the field.
 */
function Searching({ onLeaveTop, onPick }: { onLeaveTop?: () => void; onPick?: () => void }) {
  const onKeyDown = useListKeys({ onLeaveTop });
  return (
    <ul className="note-list" data-testid="list" onKeyDown={onKeyDown}>
      <li className="list-caption">Tags and notebooks</li>
      <li className="scope-match">
        <button type="button" className="scope-match-btn" data-testid="pick" onClick={onPick}>
          Receipt
        </button>
      </li>
      <li className="list-caption">Notes</li>
      <li>
        <a href="#a" className="note-item" data-testid="a">
          a
        </a>
      </li>
    </ul>
  );
}

describe('useListKeys with search picks', () => {
  it('focuses a pick without pressing it, and opens a note as it reaches it', () => {
    const onPick = vi.fn();
    render(<Searching onPick={onPick} />);
    screen.getByTestId('a').focus();
    fireEvent.keyDown(screen.getByTestId('list'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('pick'));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('list'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('a'));
  });

  it('presses a pick on Enter', () => {
    const onPick = vi.fn();
    render(<Searching onPick={onPick} />);
    screen.getByTestId('pick').focus();
    fireEvent.keyDown(screen.getByTestId('list'), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('goes back up to the field from the first row', () => {
    const onLeaveTop = vi.fn();
    render(<Searching onLeaveTop={onLeaveTop} />);
    screen.getByTestId('pick').focus();
    const prevented = !fireEvent.keyDown(screen.getByTestId('list'), { key: 'ArrowUp' });
    expect(onLeaveTop).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it('is entered on its first row, whichever kind that is', () => {
    const onPick = vi.fn();
    render(<Searching onPick={onPick} />);
    expect(enterList(screen.getByTestId('list'))).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('pick'));
    expect(onPick).not.toHaveBeenCalled();
    expect(enterList(null)).toBe(false);
  });
});
