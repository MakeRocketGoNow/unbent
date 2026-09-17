import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { NotesViewToggle } from './NotesViewToggle.js';

/**
 * One button for one bit of state. What it must not lose by being one button is what the
 * pair said for free: which view is on screen, and what a press will do.
 */
describe('NotesViewToggle', () => {
  afterEach(cleanup);

  it('names the view on screen and the one a press switches to', () => {
    const onChange = vi.fn();
    const { getByRole, rerender } = render(<NotesViewToggle value="list" onChange={onChange} />);
    fireEvent.click(getByRole('button', { name: 'Showing as a list, switch to table' }));
    expect(onChange).toHaveBeenCalledWith('table');

    rerender(<NotesViewToggle value="table" onChange={onChange} />);
    fireEvent.click(getByRole('button', { name: 'Showing as a table, switch to list' }));
    expect(onChange).toHaveBeenLastCalledWith('list');
  });

  it('is a single control', () => {
    const { getAllByRole } = render(<NotesViewToggle value="list" onChange={() => {}} />);
    expect(getAllByRole('button')).toHaveLength(1);
  });

  /* Outside a notebook the table is offered but cannot be chosen, and the name says why:
     a disabled icon with no explanation reads as broken. */
  it('is disabled with the reason in its name where there is no table to switch to', () => {
    const { getByRole } = render(
      <NotesViewToggle
        value="list"
        onChange={() => {}}
        tableDisabledReason="choose a notebook to see its fields as columns"
      />,
    );
    const button = getByRole('button', { name: /^Table view, choose a notebook/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('choose a notebook');
  });
});
