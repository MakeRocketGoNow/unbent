import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';
import { SyncingLine } from './SyncingLine.js';

vi.mock('../store/use-outbox.js', () => ({ useSyncStatus: vi.fn(), useStoreFull: vi.fn(() => null) }));
import { useStoreFull, useSyncStatus } from '../store/use-outbox.js';

/**
 * The strip says writes are waiting only once they have waited a while with a
 * connection there: not for the half second a replay takes, and not offline, where the
 * banner speaks.
 */
const status = (pending: number) => ({ pending, durable: true, waiting: new Set<string>(), conflicts: new Map(), uploadNotices: new Map() });
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

afterEach(() => {
  cleanup();
  resetConnectivity();
  vi.clearAllMocks();
});

describe('SyncingLine', () => {
  it('says nothing for a quick replay, then names the count once writes have waited', async () => {
    vi.mocked(useSyncStatus).mockReturnValue(status(2));
    render(<SyncingLine delayMs={40} />);
    expect(screen.queryByText(/Syncing/)).toBeNull();
    await wait(60);
    expect(screen.getByText('Syncing 2 changes…')).toBeTruthy();
  });

  it('says nothing offline, where the banner does', async () => {
    vi.mocked(useSyncStatus).mockReturnValue(status(2));
    setReachableForTests(false);
    render(<SyncingLine delayMs={10} />);
    await wait(40);
    expect(screen.queryByText(/Syncing/)).toBeNull();
  });

  it('says at once why writes wait when the store has no room, and what becomes of them', async () => {
    vi.mocked(useSyncStatus).mockReturnValue(status(1));
    vi.mocked(useStoreFull).mockReturnValue("This account's notes take more room than its plan allows: 1.6 GB of 1.5 GB. Delete some notes.");
    render(<SyncingLine delayMs={40} />);
    expect(screen.getByRole('status').textContent).toBe(
      "This account's notes take more room than its plan allows: 1.6 GB of 1.5 GB. Delete some notes. Your changes are kept here until there is room.",
    );
    expect(screen.queryByText(/Syncing/)).toBeNull();
  });

  it('leaves the store\u2019s refusal to the offline banner while offline', async () => {
    vi.mocked(useSyncStatus).mockReturnValue(status(1));
    vi.mocked(useStoreFull).mockReturnValue('No room.');
    setReachableForTests(false);
    render(<SyncingLine delayMs={10} />);
    await wait(30);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
