import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';
import { OfflineBanner } from './OfflineBanner.js';

vi.mock('../store/use-outbox.js', () => ({
  useLibraryPresence: vi.fn(),
  useLibraryElsewhere: vi.fn(() => null),
  useSyncStatus: vi.fn(),
}));
import { useLibraryElsewhere, useLibraryPresence, useSyncStatus } from '../store/use-outbox.js';

/**
 * What the banner promises depends on whether this tab can keep the promise: the tab
 * holding the library and leading its outbox queues writes; a tab that holds neither
 * does not, and is told so in one sentence, since the status line beside it says where
 * the notes are; and a library still opening is about to keep the promise.
 */
const status = (durable: boolean) => ({ pending: 0, durable, waiting: new Set<string>(), conflicts: new Map(), uploadNotices: new Map() });
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
    vi.mocked(useSyncStatus).mockReturnValue(status(true));
    render(<OfflineBanner />);
    expect(screen.queryByText(/offline/)).toBeNull();
  });

  it('promises the sync in the tab that holds the library and leads its outbox', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('open');
    vi.mocked(useSyncStatus).mockReturnValue(status(true));
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText(promise)).toBeTruthy();
  });

  it('promises nothing while the outbox is not yet this tab’s', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('open');
    vi.mocked(useSyncStatus).mockReturnValue(status(false));
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText("You're offline. Changes can't be saved until you're back.")).toBeTruthy();
  });

  it('says only the offline part when another tab holds the notes, since the status line says where', () => {
    vi.mocked(useLibraryPresence).mockReturnValue('none');
    vi.mocked(useLibraryElsewhere).mockReturnValue('u1');
    vi.mocked(useSyncStatus).mockReturnValue(status(false));
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText("You're offline. Changes can't be saved from this tab until you're back.")).toBeTruthy();
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
