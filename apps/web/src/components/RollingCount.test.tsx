import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { wroteLocallyWithin } from '../store/actions.js';
import { RollingCount, ROLL_MS } from './RollingCount.js';

vi.mock('../store/actions.js', () => ({ wroteLocallyWithin: vi.fn(() => false) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(wroteLocallyWithin).mockReturnValue(false);
});

function reducedMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: on && query.includes('reduce'), media: query }));
}

const cell = () => document.querySelector('.count-roll');

describe('RollingCount', () => {
  it('draws the number, and nothing to roll from on first draw', () => {
    vi.mocked(wroteLocallyWithin).mockReturnValue(true);
    render(<RollingCount value={12} className="tag-count" />);
    expect(cell()?.textContent).toBe('12');
    expect(cell()?.classList.contains('tag-count')).toBe(true);
    expect(document.querySelector('.count-out')).toBeNull();
  });

  it('rolls a change made here: a larger number up from below, the old one out above', () => {
    reducedMotion(false);
    vi.useFakeTimers();
    const { rerender } = render(<RollingCount value={39} />);
    vi.mocked(wroteLocallyWithin).mockReturnValue(true);
    rerender(<RollingCount value={40} />);

    const out = document.querySelector('.count-out');
    expect(out?.className).toBe('count-out up');
    expect(out?.textContent).toBe('39');
    expect(out?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.count-in')?.className).toBe('count-in up');
    expect(document.querySelector('.count-in')?.textContent).toBe('40');

    act(() => vi.advanceTimersByTime(ROLL_MS));
    expect(document.querySelector('.count-out')).toBeNull();
    expect(cell()?.textContent).toBe('40');
  });

  it('rolls a smaller number down from above', () => {
    reducedMotion(false);
    const { rerender } = render(<RollingCount value={31} />);
    vi.mocked(wroteLocallyWithin).mockReturnValue(true);
    rerender(<RollingCount value={30} />);
    expect(document.querySelector('.count-out')?.className).toBe('count-out down');
  });

  it('changes without a roll when the change came from elsewhere — the feed, the first copy', () => {
    reducedMotion(false);
    const { rerender } = render(<RollingCount value={26} />);
    rerender(<RollingCount value={27} />);
    expect(document.querySelector('.count-out')).toBeNull();
    expect(cell()?.textContent).toBe('27');
  });

  it('changes without a roll when reduced motion is asked for', () => {
    reducedMotion(true);
    const { rerender } = render(<RollingCount value={5} />);
    vi.mocked(wroteLocallyWithin).mockReturnValue(true);
    rerender(<RollingCount value={6} />);
    expect(document.querySelector('.count-out')).toBeNull();
    expect(cell()?.textContent).toBe('6');
  });
});
