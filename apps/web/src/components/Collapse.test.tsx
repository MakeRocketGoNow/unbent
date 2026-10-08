import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Collapse, COLLAPSE_MS } from './Collapse.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function reducedMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: on && query.includes('reduce'), media: query }));
}

describe('Collapse', () => {
  it('draws nothing while closed, so closed content costs nothing', () => {
    render(<Collapse open={false}>Lines</Collapse>);
    expect(screen.queryByText('Lines')).toBeNull();
  });

  it('keeps the content through a close, out of reach, and lets it go once the close has run', () => {
    reducedMotion(false);
    vi.useFakeTimers();
    const { rerender } = render(<Collapse open>Lines</Collapse>);
    const box = screen.getByText('Lines').closest('.collapse');
    expect(box?.classList.contains('open')).toBe(true);
    expect(box?.hasAttribute('inert')).toBe(false);

    rerender(<Collapse open={false}>Lines</Collapse>);
    expect(box?.classList.contains('open')).toBe(false);
    expect(box?.hasAttribute('inert')).toBe(true);
    act(() => vi.advanceTimersByTime(COLLAPSE_MS));
    expect(screen.queryByText('Lines')).toBeNull();
  });

  it('opens again over a close still running, keeping the same content', () => {
    reducedMotion(false);
    vi.useFakeTimers();
    const { rerender } = render(<Collapse open>Lines</Collapse>);
    rerender(<Collapse open={false}>Lines</Collapse>);
    act(() => vi.advanceTimersByTime(COLLAPSE_MS / 2));
    rerender(<Collapse open>Lines</Collapse>);
    act(() => vi.advanceTimersByTime(COLLAPSE_MS));
    expect(screen.getByText('Lines').closest('.collapse')?.classList.contains('open')).toBe(true);
  });

  it('closes at once with reduced motion asked for', () => {
    reducedMotion(true);
    vi.useFakeTimers();
    const { rerender } = render(<Collapse open>Lines</Collapse>);
    rerender(<Collapse open={false}>Lines</Collapse>);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.queryByText('Lines')).toBeNull();
  });

  it('names its box for the control that opens it, and lays the content out in the class given', () => {
    render(
      <Collapse open id="tags" className="drawer-tags">
        Lines
      </Collapse>,
    );
    expect(document.getElementById('tags')?.classList.contains('collapse')).toBe(true);
    expect(screen.getByText('Lines').classList.contains('drawer-tags')).toBe(true);
  });
});
