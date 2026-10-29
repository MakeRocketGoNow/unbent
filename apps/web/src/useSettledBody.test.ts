import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSettledBody } from './useSettledBody.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useSettledBody', () => {
  it('answers the body as it stood when typing last paused', () => {
    const { result, rerender } = renderHook(({ id, body }) => useSettledBody(id, body, '', 250), {
      initialProps: { id: 'n1', body: 'a' },
    });
    expect(result.current).toBe('a');
    rerender({ id: 'n1', body: 'ab' });
    rerender({ id: 'n1', body: 'abc' });
    expect(result.current).toBe('a');
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe('a');
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe('abc');
  });

  it('answers the new note\'s body at once on a switch, never the previous note\'s', () => {
    const { result, rerender } = renderHook(({ id, body }) => useSettledBody(id, body, '', 250), {
      initialProps: { id: 'n1', body: 'first' },
    });
    rerender({ id: 'n2', body: 'second' });
    expect(result.current).toBe('second');
    // The switch settles on the next tick, not after the pause; typing then waits for it.
    act(() => vi.advanceTimersByTime(0));
    rerender({ id: 'n2', body: 'second!' });
    expect(result.current).toBe('second');
    act(() => vi.advanceTimersByTime(250));
    expect(result.current).toBe('second!');
  });

  it('answers the live body at once when what it is read against changes', () => {
    const { result, rerender } = renderHook(
      ({ body, files }) => useSettledBody('n1', body, files, 250),
      { initialProps: { body: '[a](files/a.pdf)', files: 'a.pdf' } },
    );
    rerender({ body: '[a](files/a.pdf) [b](files/b.pdf)', files: 'a.pdf' });
    expect(result.current).toBe('[a](files/a.pdf)');
    rerender({ body: '[a](files/a.pdf) [b](files/b.pdf)', files: 'a.pdf\nb.pdf' });
    expect(result.current).toBe('[a](files/a.pdf) [b](files/b.pdf)');
  });
});
