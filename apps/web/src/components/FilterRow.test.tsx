import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { FilterRow } from './FilterRow.js';

/**
 * A filter that opens a page of its own.
 *
 * The value is the reason this is not a plain button: a row reading only "Tags" says where
 * to go and nothing about where you already are, on a surface whose whole job is reporting
 * what is applied. It has to reach a screen reader too, since the visual column is the only
 * other place it appears.
 */
describe('FilterRow', () => {
  afterEach(cleanup);

  it('names the filter alone when nothing is set', () => {
    const { getByRole } = render(<FilterRow icon={<svg data-testid="icon" />} label="Tags" onClick={() => {}} />);
    expect(getByRole('button').getAttribute('aria-label')).toBe('Tags');
    expect(getByRole('button').textContent).toBe('Tags');
  });

  it('carries the value on screen and in the accessible name', () => {
    const { getByRole, container } = render(
      <FilterRow icon={<svg data-testid="icon" />} label="Tags" value="3 tags" onClick={() => {}} />,
    );
    expect(getByRole('button').getAttribute('aria-label')).toBe('Tags, 3 tags');
    expect(container.querySelector('.filter-row-value')?.textContent).toBe('3 tags');
  });

  /* The icon names the row alongside the label, so a screen reader must not hear both —
     the accessible name is the label and the value, and nothing else. */
  it('draws the icon without letting it into the accessible name', () => {
    const { getByRole, getByTestId } = render(
      <FilterRow icon={<svg data-testid="icon" />} label="Tags" value="3 tags" onClick={() => {}} />,
    );
    expect(getByTestId('icon')).toBeTruthy();
    expect(getByRole('button').getAttribute('aria-label')).toBe('Tags, 3 tags');
  });

  it('opens its page when pressed', () => {
    const onClick = vi.fn();
    const { getByRole } = render(<FilterRow icon={<svg data-testid="icon" />} label="Tags" onClick={onClick} />);
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
