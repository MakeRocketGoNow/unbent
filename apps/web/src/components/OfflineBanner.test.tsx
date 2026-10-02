import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';
import { OfflineBanner } from './OfflineBanner.js';

vi.mock('../store/use-outbox.js', () => ({
  useLibraryPresence: vi.fn(),
  useSyncStatus: vi.fn(),
}));
import { useLibraryPresence, useSyncStatus } from '../store/use-outbox.js';

/**
 * What the banner promises depends on whether this tab can keep the promise: only the tab
 * holding the outbox queues writes, a device with no library queues nothing, and a
 * library still opening is about to.
 */
const status = (durable: boolean) => ({ pending: 0, durable, waiting: new Set<string>(), conflicts: new Map() });
const promise = /what you change will sync when you're back/;

afterEach(() => {
  cleanup();
  resetConnectivity();
  vi.clearAllMocks();
});

describe('OfflineBanner', () => {
  it('says nothing while online', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('open');
    vi.mocked(useSyncStatus).mockReturnValue(status(true));
    render(<OfflineBanner />);
    expect(screen.queryByText(/offline/)).toBeNull();
  });

  it('promises the sync in the tab that holds the outbox', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('open');
    vi.mocked(useSyncStatus).mockReturnValue(status(true));
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText(promise)).toBeTruthy();
  });

  it('says where the changes are kept in any other tab of the account', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('open');
    vi.mocked(useSyncStatus).mockReturnValue(status(false));
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText("You're offline. Changes can't be saved from this tab while offline — another Unbent tab is keeping your changes.")).toBeTruthy();
  });

  it('promises nothing on a device with no library', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('none');
    vi.mocked(useSyncStatus).mockReturnValue(status(false));
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText("You're offline. Changes can't be saved until you're back.")).toBeTruthy();
  });

  it('keeps the promise while the library is still opening', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('opening');
    vi.mocked(useSyncStatus).mockReturnValue(status(false));
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText(promise)).toBeTruthy();
  });
});
