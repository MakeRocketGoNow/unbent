import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';
import { OfflineBanner } from './OfflineBanner.js';

vi.mock('../store/use-outbox.js', () => ({
  useOutbox: vi.fn(),
  useSyncStatus: vi.fn(),
}));
import { useOutbox, useSyncStatus } from '../store/use-outbox.js';

/**
 * What the banner promises depends on whether this tab can keep the promise: only the tab
 * holding the outbox queues writes, and a device with no library queues nothing.
 */
const status = (durable: boolean) => ({ pending: 0, durable, conflicts: new Map() });

afterEach(() => {
  cleanup();
  resetConnectivity();
  vi.clearAllMocks();
});

describe('OfflineBanner', () => {
  it('says nothing while online', () => {
    vi.mocked(useOutbox).mockReturnValue({} as never);
    vi.mocked(useSyncStatus).mockReturnValue(status(true));
    render(<OfflineBanner />);
    expect(screen.queryByText(/offline/)).toBeNull();
  });

  it('promises the sync in the tab that holds the outbox', () => {
    vi.mocked(useOutbox).mockReturnValue({} as never);
    vi.mocked(useSyncStatus).mockReturnValue(status(true));
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText(/what you change will sync when you're back/)).toBeTruthy();
  });

  it('names the first tab in any other tab of the account', () => {
    vi.mocked(useOutbox).mockReturnValue({} as never);
    vi.mocked(useSyncStatus).mockReturnValue(status(false));
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText(/can't be saved from this tab until you're back — use your first tab/)).toBeTruthy();
  });

  it('promises nothing on a device with no library', () => {
    vi.mocked(useOutbox).mockReturnValue(null);
    vi.mocked(useSyncStatus).mockReturnValue(status(false));
    setReachableForTests(false);
    render(<OfflineBanner />);
    expect(screen.getByText("You're offline. Changes can't be saved until you're back.")).toBeTruthy();
  });
});
