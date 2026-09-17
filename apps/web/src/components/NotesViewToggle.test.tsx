import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { NotesViewToggle } from './NotesViewToggle.js';

describe('NotesViewToggle', () => {
  afterEach(cleanup);

  it('marks the view in effect and reports a change', () => {
    const onChange = vi.fn();
    const { getByLabelText } = render(<NotesViewToggle value="list" onChange={onChange} />);
    expect(getByLabelText('List view').getAttribute('aria-pressed')).toBe('true');
    expect(getByLabelText('Table view').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(getByLabelText('Table view'));
    expect(onChange).toHaveBeenCalledWith('table');
  });

  /* Outside a notebook the table is offered but cannot be chosen, and the name says why:
     a disabled icon with no explanation reads as broken. */
  it('disables the table with the reason in its name', () => {
    const { getByLabelText } = render(
      <NotesViewToggle
        value="list"
        onChange={() => {}}
        tableDisabledReason="choose a notebook to see its fields as columns"
      />,
    );
    const table = getByLabelText(/^Table view, choose a notebook/) as HTMLButtonElement;
    expect(table.disabled).toBe(true);
    expect(table.title).toContain('choose a notebook');
  });
});
