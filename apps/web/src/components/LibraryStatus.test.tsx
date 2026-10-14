import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LibraryStatus } from './LibraryStatus.js';

vi.mock('../store/use-feed-state.js', () => ({ useLibraryArriving: vi.fn() }));
import { useLibraryArriving } from '../store/use-feed-state.js';

/**
 * The line says the library is on its way in both of its stages, and says nothing once
 * it is here. The first open on a phone looked like an empty, broken app before the line
 * covered the opening of the store as well.
 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LibraryStatus', () => {
  it('says the store is opening, before there is anything to count', () => {
    vi.mocked(useLibraryArriving).mockReturnValue({ stage: 'opening', applied: 0, total: null });
    render(<LibraryStatus />);
    expect(screen.getByRole('status').textContent).toBe('Opening your notes…');
  });

  it('counts the copy once it is under way', () => {
    vi.mocked(useLibraryArriving).mockReturnValue({ stage: 'copying', applied: 120, total: 4000 });
    render(<LibraryStatus />);
    expect(screen.getByRole('status').textContent).toBe('Copying your notes to this device… 120 of 4000');
  });

  it('says nothing once the library is here', () => {
    vi.mocked(useLibraryArriving).mockReturnValue(null);
    render(<LibraryStatus />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
