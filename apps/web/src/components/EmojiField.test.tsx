import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { EmojiField } from './EmojiField.js';

/**
 * The square and the panel around frimousse's grid. The grid itself is frimousse's and is
 * virtualised from measured row heights, which jsdom does not have, so choosing a cell is
 * left to the browser; what is pinned here is this component's part — what the square
 * shows and says, how the panel opens and closes, and "Remove".
 */
describe('EmojiField', () => {
  beforeEach(() => {
    // frimousse measures its viewport and fetches its emoji data when the panel opens;
    // neither is needed for what these pin, so the observer is inert and the fetch waits.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('shows the book and offers a choice when the notebook has no emoji', () => {
    const { container } = render(<EmojiField emoji={null} name="Coupons" onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Choose an emoji for Coupons' });
    expect(trigger.querySelector('svg')).toBeTruthy();
    expect(container.querySelector('.notebook-emoji')).toBeNull();
  });

  it('shows the emoji and offers a change when the notebook has one', () => {
    render(<EmojiField emoji="🧾" name="Coupons" onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Change the emoji for Coupons' });
    expect(trigger.textContent).toBe('🧾');
  });

  it('opens the picker with its search focused', () => {
    render(<EmojiField emoji={null} name="Coupons" onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Choose an emoji for Coupons' });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Choose an emoji' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Search emoji'));
  });

  // Remove is only the way back to the book, so a notebook already on the book has none.
  it('offers Remove only when there is an emoji to remove', () => {
    render(<EmojiField emoji={null} name="Coupons" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose an emoji for Coupons' }));
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('removes the emoji, closes, and hands focus back to the square', () => {
    const onChange = vi.fn();
    render(<EmojiField emoji="🧾" name="Coupons" onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Change the emoji for Coupons' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes without a change on a press outside or on Escape', () => {
    const onChange = vi.fn();
    render(<EmojiField emoji="🧾" name="Coupons" onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Change the emoji for Coupons' });

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByLabelText('Search emoji'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    expect(onChange).not.toHaveBeenCalled();
  });
});
