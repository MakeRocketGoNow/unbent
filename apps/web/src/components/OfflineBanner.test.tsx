import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';
import { OfflineBanner } from './OfflineBanner.js';

vi.mock('../store/use-outbox.js', () => ({
  useLibraryPresence: vi.fn(),
  useLibraryElsewhere: vi.fn(() => null),
}));
import { useLibraryElsewhere, useLibraryPresence } from '../store/use-outbox.js';

/**
 * What the banner promises depends on whether this tab can keep the promise: the tab
 * holding the library queues writes, a tab whose library another tab holds does not and
 * says where the notes are, a device with no library queues nothing, and a library still
 * opening is about to.
 */
const promise = /what you change will sync when you're back/;

afterEach(() => {
  cleanup();
  resetConnectivity();
  vi.clearAllMocks();
  vi.mocked(useLibraryElsewhere).mockReturnValue(null);
});

describe('OfflineBanner', () => {
  it('says nothing while online', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('open');
    render(<OfflineBanner />);
    expect(screen.queryByText(/offline/)).toBeNull();
  });

  it('promises the sync in the tab that holds the library', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('open');
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText(promise)).toBeTruthy();
  });

  it('says where the notes are when another tab holds them', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('none');
    vi.mocked(useLibraryElsewhere).mockReturnValue('u1');
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText("You're offline. Your notes are open in another tab, and changes can't be saved from this one until you're back.")).toBeTruthy();
  });

  it('promises nothing on a device with no library', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('none');
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText("You're offline. Changes can't be saved until you're back.")).toBeTruthy();
  });

  it('keeps the promise while the library is still opening', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('opening');
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText(promise)).toBeTruthy();
  });
});
