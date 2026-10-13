import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LibraryStatus } from './LibraryStatus.js';

vi.mock('../store/use-feed-state.js', () => ({ useLibraryArriving: vi.fn() }));
vi.mock('../store/use-outbox.js', () => ({ useLibraryElsewhere: vi.fn(() => null) }));
vi.mock('../store/library.js', () => ({ takeOverLibrary: vi.fn(() => Promise.resolve()) }));
import { useLibraryArriving } from '../store/use-feed-state.js';
import { useLibraryElsewhere } from '../store/use-outbox.js';
import { takeOverLibrary } from '../store/library.js';

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

  /* Another tab holds the library: the line says so and holds the one way to take it,
     a button whose tip says what happens to the other tab, read out as its description. */
  it('says the notes are open in another tab, and takes them over on Open here', () => {
    vi.mocked(useLibraryArriving).mockReturnValue(null);
    vi.mocked(useLibraryElsewhere).mockReturnValue('u1');
    render(<LibraryStatus />);
    expect(screen.getByRole('status').textContent).toContain('Your notes are open in another tab.');
    const button = screen.getByRole('button', { name: 'Open here' });
    expect(button.getAttribute('aria-description')).toMatch(/other tab or window/);
    fireEvent.click(button);
    expect(takeOverLibrary).toHaveBeenCalledTimes(1);
    vi.mocked(useLibraryElsewhere).mockReturnValue(null);
  });
});
