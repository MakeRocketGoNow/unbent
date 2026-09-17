import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { FieldScale } from '@unbent/shared';
import { RatingInput } from './RatingInput.js';

/**
 * A rating has two ways in and they must not fight: a click on a star means that whole
 * star, and a drag across the row means the half-star zone under the pointer. They did
 * fight once — the row committed the pointer's position on press, so clicking the middle
 * of the third star stored 2.5, because a star's own centre falls in one of its two
 * half-zones. The click tests below are that bug.
 *
 * jsdom gives every element a zero-size rect, so the row is measured by stubbing
 * `getBoundingClientRect`: the drag tests need real geometry to have a position to read.
 */
const halves: FieldScale = { max: 5, step: 0.5 };
const wholes: FieldScale = { max: 5, step: 1 };

/** Puts a 100px-wide row at x=0, so each of ten half-zones is 10px. */
function measureRow() {
  const row = document.querySelector('.note-field-stars');
  if (!row) throw new Error('no star row');
  row.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20, x: 0, y: 0 }) as DOMRect;
  return row;
}

afterEach(cleanup);

describe('clicking a star', () => {
  it('means that whole star, not the half its centre falls in', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={null} onChange={onChange} label="Rating" />);
    fireEvent.click(screen.getByRole('radio', { name: '3 of 5' }));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('works for every star on the row', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={null} onChange={onChange} label="Rating" />);
    for (const star of [1, 2, 4, 5]) {
      fireEvent.click(screen.getByRole('radio', { name: `${star} of 5` }));
      expect(onChange).toHaveBeenLastCalledWith(star);
    }
  });

  it('is a press and release in place, which is not a drag', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={null} onChange={onChange} label="Rating" />);
    const row = measureRow();
    // Down and up at the same point, as a click is: the position must not be committed.
    fireEvent.pointerDown(row, { clientX: 25, button: 0, pointerId: 1 });
    fireEvent.pointerUp(row, { clientX: 25, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('dragging across the row', () => {
  it('commits the half-star zone under the pointer', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={null} onChange={onChange} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerDown(row, { clientX: 5, button: 0, pointerId: 1 });
    // Past the slop, so this is a drag; 45px of 100 is the 5th of ten zones — 2.5.
    fireEvent.pointerMove(row, { clientX: 45, pointerId: 1 });
    fireEvent.pointerUp(row, { clientX: 45, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(2.5);
  });

  it('shows the value it would commit before the pointer is lifted', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={null} onChange={onChange} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerDown(row, { clientX: 5, button: 0, pointerId: 1 });
    // 65px of 100 is the 7th of ten zones — 3.5, so the 4th star is drawn half filled.
    fireEvent.pointerMove(row, { clientX: 65, pointerId: 1 });
    // Nothing is saved yet: the fill is a preview of what lifting here would commit.
    expect(onChange).not.toHaveBeenCalled();
    const fills = [...document.querySelectorAll('.note-field-star')].map(
      (s) => (s as HTMLElement).dataset['fill'],
    );
    expect(fills).toEqual(['full', 'full', 'full', 'half', 'empty']);
  });

  it('never lands between the steps on a whole-star scale', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={wholes} value={null} onChange={onChange} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerDown(row, { clientX: 5, button: 0, pointerId: 1 });
    fireEvent.pointerMove(row, { clientX: 45, pointerId: 1 });
    fireEvent.pointerUp(row, { clientX: 45, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('cannot ask for a rating of zero by dragging off the left edge', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={4} onChange={onChange} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerDown(row, { clientX: 50, button: 0, pointerId: 1 });
    fireEvent.pointerMove(row, { clientX: -40, pointerId: 1 });
    fireEvent.pointerUp(row, { clientX: -40, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(0.5);
  });
});

describe('what the row draws', () => {
  it('fills whole stars and a half for the value held', () => {
    render(<RatingInput scale={halves} value={3.5} onChange={vi.fn()} label="Rating" />);
    const fills = [...document.querySelectorAll('.note-field-star')].map(
      (s) => (s as HTMLElement).dataset['fill'],
    );
    expect(fills).toEqual(['full', 'full', 'full', 'half', 'empty']);
  });

  it('draws a half as the hollow glyph with a filled one over it', () => {
    render(<RatingInput scale={halves} value={2.5} onChange={vi.fn()} label="Rating" />);
    const third = document.querySelectorAll('.note-field-star')[2] as HTMLElement;
    expect(third.querySelector('.note-field-star-half')).not.toBeNull();
    expect(third.textContent).toBe('☆★');
  });

  it('names each star for a screen reader', () => {
    render(<RatingInput scale={halves} value={null} onChange={vi.fn()} label="Rating" />);
    expect(screen.getByRole('radiogroup', { name: 'Rating' })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByRole('radio', { name: '5 of 5' })).toBeTruthy();
  });

  it('says Empty when there is no rating, and offers no way to clear one', () => {
    render(<RatingInput scale={halves} value={null} onChange={vi.fn()} label="Rating" />);
    expect(screen.getByText('Empty')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
  });

  it('clears back to no rating, since there is no zero star to click', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={3} onChange={onChange} label="Rating" />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Rating' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe('a scale too wide for stars', () => {
  it('is a number over its max rather than a row of ten glyphs', () => {
    render(
      <RatingInput scale={{ max: 10, step: 1 }} value={7} onChange={vi.fn()} label="Score" />,
    );
    expect(document.querySelectorAll('.note-field-star')).toHaveLength(0);
    expect(screen.getByText('/10')).toBeTruthy();
    expect(screen.getByLabelText('Score')).toHaveProperty('value', '7');
  });

  it('clears on an emptied input and holds what is typed otherwise', () => {
    const onChange = vi.fn();
    render(
      <RatingInput scale={{ max: 10, step: 1 }} value={7} onChange={onChange} label="Score" />,
    );
    const input = screen.getByLabelText('Score');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
    fireEvent.change(input, { target: { value: '8' } });
    expect(onChange).toHaveBeenLastCalledWith(8);
  });
});

describe('read-only', () => {
  it('sets nothing, by pointer or by star', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={3} readOnly onChange={onChange} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerDown(row, { clientX: 5, button: 0, pointerId: 1 });
    fireEvent.pointerMove(row, { clientX: 75, pointerId: 1 });
    fireEvent.pointerUp(row, { clientX: 75, pointerId: 1 });
    fireEvent.click(screen.getByRole('radio', { name: '5 of 5' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
  });
});
