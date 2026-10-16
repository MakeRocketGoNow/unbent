import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { FieldScale } from '@unbent/shared';
import { RatingInput } from './RatingInput.js';

/**
 * A rating has two ways in and they must not fight: a click on a star means that whole
 * star, and a drag across the row means the half-star zone under the pointer. They did
 * fight once: the row committed the pointer's position on press, so clicking the middle
 * of the third star stored 2.5, because a star's own centre falls in one of its two
 * half-zones. The click tests below are that bug.
 *
 * jsdom gives every element a zero-size rect, so the row is measured by stubbing
 * `getBoundingClientRect`: the drag tests need real geometry to have a position to read.
 */
const halves: FieldScale = { max: 5, step: 0.5 };
const wholes: FieldScale = { max: 5, step: 1 };

/**
 * jsdom ships no `matchMedia`, and the control asks `TOUCH_QUERY` which half-star
 * mechanic to use, so this is both the switch between them and what keeps the component
 * mountable at all. `false` is a mouse, which is the default every test here assumes
 * unless it is about the touch behaviour.
 */
function stubTouch(isTouch: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: isTouch,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => stubTouch(false));

/** How each star is drawn, left to right. */
const fills = () =>
  [...document.querySelectorAll('.note-field-star')].map(
    (s) => (s as HTMLElement).dataset['fill'],
  );

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
    // Past the slop, so this is a drag; 45px of 100 is the 5th of ten zones: 2.5.
    fireEvent.pointerMove(row, { clientX: 45, pointerId: 1 });
    fireEvent.pointerUp(row, { clientX: 45, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(2.5);
  });

  it('shows the value it would commit before the pointer is lifted', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={null} onChange={onChange} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerDown(row, { clientX: 5, button: 0, pointerId: 1 });
    // 65px of 100 is the 7th of ten zones: 3.5, so the 4th star is drawn half filled.
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

describe('a half by pointer position (mouse)', () => {
  it('takes the half when the mouse is over a star\'s left side', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={null} onChange={onChange} label="Rating" />);
    const row = measureRow();
    // 45px of 100 is the 5th of ten zones: the left half of star 3.
    fireEvent.pointerMove(row, { clientX: 45, pointerId: 1, pointerType: 'mouse' });
    fireEvent.click(screen.getByRole('radio', { name: '3 of 5' }));
    expect(onChange).toHaveBeenCalledWith(2.5);
  });

  it('takes the whole star when the mouse is over its right side', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={null} onChange={onChange} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerMove(row, { clientX: 55, pointerId: 1, pointerType: 'mouse' });
    fireEvent.click(screen.getByRole('radio', { name: '3 of 5' }));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('previews what a click would set, before it is clicked', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={null} onChange={onChange} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerMove(row, { clientX: 45, pointerId: 1, pointerType: 'mouse' });
    expect(onChange).not.toHaveBeenCalled();
    expect(fills()).toEqual(['full', 'full', 'half', 'empty', 'empty']);
    // And the preview is drawn as provisional, not as a chosen value.
    expect(document.querySelector('.note-field-stars')?.hasAttribute('data-preview')).toBe(true);
  });

  it('draws a preview with the same glyphs a chosen rating uses', () => {
    /*
       The row, not the stars, says a rating is provisional: `data-preview` drives a wash
       in the stylesheet. Two earlier attempts marked the glyphs instead: dimming them hit
       the app's own `:disabled` look, and hollowing them made a preview of five read as an
       empty rating. So a previewed 3 and a stored 3 draw identically, on purpose.
    */
    const { unmount } = render(
      <RatingInput scale={halves} value={null} onChange={vi.fn()} label="Rating" />,
    );
    const row = measureRow();
    fireEvent.pointerMove(row, { clientX: 55, pointerId: 1, pointerType: 'mouse' });
    const previewed = [...document.querySelectorAll('.note-field-star')].map((s) => s.textContent);
    expect(row.hasAttribute('data-preview')).toBe(true);
    unmount();

    render(<RatingInput scale={halves} value={3} onChange={vi.fn()} label="Rating" />);
    const committed = [...document.querySelectorAll('.note-field-star')].map((s) => s.textContent);
    expect(previewed).toEqual(committed);
    expect(committed[0]).toBe('★');
  });

  it('draws a committed rating solid', () => {
    render(<RatingInput scale={halves} value={2} onChange={vi.fn()} label="Rating" />);
    const stars = [...document.querySelectorAll('.note-field-star')];
    expect(stars[0]?.textContent).toBe('★');
    expect(stars[1]?.textContent).toBe('★');
    expect(stars[2]?.textContent).toBe('☆');
  });

  it('gives the row back to the stored value when the mouse leaves', () => {
    render(<RatingInput scale={halves} value={4} onChange={vi.fn()} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerMove(row, { clientX: 15, pointerId: 1, pointerType: 'mouse' });
    expect(fills()).toEqual(['full', 'empty', 'empty', 'empty', 'empty']);
    fireEvent.pointerLeave(row);
    expect(fills()).toEqual(['full', 'full', 'full', 'full', 'empty']);
    expect(document.querySelector('.note-field-stars')?.hasAttribute('data-preview')).toBe(false);
  });

  it('does not preview from a touch pointer, which has no hover', () => {
    render(<RatingInput scale={halves} value={null} onChange={vi.fn()} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerMove(row, { clientX: 45, pointerId: 1, pointerType: 'touch' });
    expect(fills()).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
  });

  it('keeps a whole-star scale on whole stars wherever the mouse is', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={wholes} value={null} onChange={onChange} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerMove(row, { clientX: 45, pointerId: 1, pointerType: 'mouse' });
    fireEvent.click(screen.getByRole('radio', { name: '3 of 5' }));
    expect(onChange).toHaveBeenCalledWith(3);
  });
});

describe('a half by repeat tap (touch)', () => {
  beforeEach(() => stubTouch(true));

  it('sets the whole star on the first tap', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={null} onChange={onChange} label="Rating" />);
    fireEvent.click(screen.getByRole('radio', { name: '3 of 5' }));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('drops to the half when the same star is tapped again', () => {
    const onChange = vi.fn();
    // `value` is what the note holds, so tapping the star it already sits on toggles.
    render(<RatingInput scale={halves} value={3} onChange={onChange} label="Rating" />);
    fireEvent.click(screen.getByRole('radio', { name: '3 of 5' }));
    expect(onChange).toHaveBeenCalledWith(2.5);
  });

  it('returns to the whole star on the tap after that', () => {
    const onChange = vi.fn();
    // At 2.5 the rating no longer equals star 3, so the next tap is a plain set.
    render(<RatingInput scale={halves} value={2.5} onChange={onChange} label="Rating" />);
    fireEvent.click(screen.getByRole('radio', { name: '3 of 5' }));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('sets the whole star when a different star is tapped', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={3} onChange={onChange} label="Rating" />);
    fireEvent.click(screen.getByRole('radio', { name: '5 of 5' }));
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('can reach the lowest half, on the first star', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={1} onChange={onChange} label="Rating" />);
    fireEvent.click(screen.getByRole('radio', { name: '1 of 5' }));
    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it('does not toggle on a scale with no halves', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={wholes} value={3} onChange={onChange} label="Rating" />);
    fireEvent.click(screen.getByRole('radio', { name: '3 of 5' }));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('ignores pointer position entirely, so a thumb anywhere on the star works', () => {
    const onChange = vi.fn();
    render(<RatingInput scale={halves} value={null} onChange={onChange} label="Rating" />);
    const row = measureRow();
    // A position that would mean 2.5 on a mouse; on touch the star decides, not the x.
    fireEvent.pointerMove(row, { clientX: 45, pointerId: 1, pointerType: 'touch' });
    fireEvent.click(screen.getByRole('radio', { name: '3 of 5' }));
    expect(onChange).toHaveBeenCalledWith(3);
  });
});

describe('which radio is checked', () => {
  it('follows the stored value, not a hover preview', () => {
    render(<RatingInput scale={halves} value={4} onChange={vi.fn()} label="Rating" />);
    const row = measureRow();
    fireEvent.pointerMove(row, { clientX: 15, pointerId: 1, pointerType: 'mouse' });
    // The fill previews 1, but the checked radio is still the value the note holds.
    expect(fills()[0]).toBe('full');
    expect(screen.getByRole('radio', { name: '4 of 5' })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: '1 of 5' })).toHaveProperty('checked', false);
  });

  it('names every star for what it is, whatever the value', () => {
    stubTouch(true);
    render(<RatingInput scale={halves} value={3} onChange={vi.fn()} label="Rating" />);
    // Not "2.5 of 5" on the star a repeat tap would halve: a radio's name says what it
    // is, so the group's names cannot disagree with its values.
    expect(screen.getByRole('radio', { name: '3 of 5' })).toBeTruthy();
  });
});
