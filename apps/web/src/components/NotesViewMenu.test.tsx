import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { NotesViewMenu } from './NotesViewMenu.js';

/**
 * One icon for three views. What it must keep from the flip button it replaced is what
 * that said for free: which view is on screen. And what the menu adds must hold: every
 * view by name, the current one marked, the table's reason where it cannot be chosen.
 */
describe('NotesViewMenu', () => {
  afterEach(cleanup);

  it('names the view on screen, and is a single control until opened', () => {
    const { rerender } = render(<NotesViewMenu value="list" onChange={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Showing as a list' })).toBeTruthy();
    rerender(<NotesViewMenu value="cards" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Showing as cards' })).toBeTruthy();
    rerender(<NotesViewMenu value="table" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Showing as a table' }).dataset.tip).toBe('Change view');
  });

  it('offers the three views by name, the current one marked', () => {
    render(<NotesViewMenu value="cards" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Showing as cards' }));
    const list = screen.getByRole('button', { name: 'List' });
    const cards = screen.getByRole('button', { name: 'Cards' });
    const table = screen.getByRole('button', { name: 'Table' });
    expect(list.getAttribute('aria-pressed')).toBe('false');
    expect(cards.getAttribute('aria-pressed')).toBe('true');
    expect(table.getAttribute('aria-pressed')).toBe('false');
  });

  it('switches to the view picked, and does nothing for the one on screen', () => {
    const onChange = vi.fn();
    render(<NotesViewMenu value="list" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Showing as a list' }));
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Showing as a list' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
    expect(onChange).toHaveBeenCalledWith('cards');
  });

  /* A remembered table drawn as a list outside a notebook: List is ticked, and picking it
     must still record List, or the table comes back in the next notebook. */
  it('records the view picked when it is shown but another was asked for', () => {
    const onChange = vi.fn();
    render(
      <NotesViewMenu
        value="list"
        requested="table"
        onChange={onChange}
        tableDisabledReason="Choose a notebook to see its fields as columns"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Showing as a list' }));
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(onChange).toHaveBeenCalledWith('list');
  });

  /* Outside a notebook the table is offered but cannot be chosen, and says why under its
     name, visibly: a faded item with no reason reads as broken, and a phone has no
     tooltip to put one in. The cards stay on offer. */
  it('fades the table with its reason where there is none to draw', () => {
    const onChange = vi.fn();
    render(
      <NotesViewMenu
        value="list"
        onChange={onChange}
        tableDisabledReason="Choose a notebook to see its fields as columns"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Showing as a list' }));
    const table = screen.getByRole('button', { name: /^Table/ }) as HTMLButtonElement;
    expect(table.disabled).toBe(true);
    expect(table.textContent).toContain('Choose a notebook to see its fields as columns');
    expect((screen.getByRole('button', { name: 'Cards' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(table);
    expect(onChange).not.toHaveBeenCalled();
  });
});
