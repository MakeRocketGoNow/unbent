import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useListKeys, useCameFromList, registerEditorFocus, focusActiveListItem } from './useListKeys.js';

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

    // A click on a different note must not inherit the arrow keys' no-focus rule.
    fireEvent.pointerDown(screen.getByTestId('c'));
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
