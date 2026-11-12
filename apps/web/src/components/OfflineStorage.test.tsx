import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OfflineStorage } from './OfflineStorage.js';

vi.mock('@tanstack/react-router', () => ({ Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => <a href={to} {...rest}>{children}</a> }));
vi.mock('../queries.js', () => ({
  notebooksQuery: () => ({ queryKey: ['notebooks'], queryFn: async () => ({ notebooks: [], unfiled: 0 }) }),
  notebookFilesQuery: (id: string) => ({ queryKey: ['notebook-files', id], queryFn: async () => ({ files: 0, bytes: 0 }) }),
}));
vi.mock('../store/use-outbox.js', () => ({
  useKeeper: vi.fn(() => ({ keeper: null, status: { supported: false, kept: new Set(), counted: false, wanted: { files: 0, bytes: 0 }, have: { files: 0, bytes: 0 }, fetching: false, problem: null } })),
  useLibraryElsewhere: vi.fn(() => null),
  useLibraryPresence: vi.fn(() => 'open'),
  useSyncStatus: vi.fn(() => ({ pending: 0, durable: true, waiting: new Set(), conflicts: new Map(), uploadNotices: new Map(), storeFull: null })),
}));
vi.mock('../store/library.js', () => ({ currentLibraryUser: () => null, takeOverLibrary: vi.fn(() => Promise.resolve()) }));
vi.mock('../store/files.js', () => ({ listShelf: async () => [], storagePersisted: async () => null }));
vi.mock('../sw/budget.js', () => ({ FILES_BUDGET: { bytes: 500 * 1024 * 1024, files: 500, ageMs: 30 * 86400000 }, openedFilesUsage: async () => ({ files: 0, bytes: 0 }) }));
vi.mock('../sw/routes.js', () => ({ FILES_CACHE: 'unbent-files' }));
vi.mock('./KeepOffline.js', () => ({ useDeviceRoom: vi.fn(() => ({ room: null, refresh: () => {} })) }));
vi.mock('../store/usage.js', () => ({ storedBytes: vi.fn(async () => null) }));
vi.mock('../sw-register.js', () => ({ useOfflineReady: () => 'ready' }));
vi.mock('../connectivity.js', () => ({ useConnectivityReport: () => ({ offline: false, browserOnLine: true, decided: { by: 'start', at: 0 }, since: null }) }));
import { useLibraryElsewhere, useLibraryPresence } from '../store/use-outbox.js';
import { takeOverLibrary } from '../store/library.js';
import { useDeviceRoom } from './KeepOffline.js';
import { storedBytes } from '../store/usage.js';

/**
 * The intro says which of three things this tab is (the holder, a client working
 * through the holder, or a tab with no library at all) and the one way to bring the
 * library here is drawn only when another tab holds it, with its tip read out as the
 * button's description, as the tooltip rule asks.
 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(useLibraryElsewhere).mockReturnValue(null);
  vi.mocked(useLibraryPresence).mockReturnValue('open');
  vi.mocked(useDeviceRoom).mockReturnValue({ room: null, refresh: () => {} });
  vi.mocked(storedBytes).mockResolvedValue(null);
});

const draw = () => render(<QueryClientProvider client={new QueryClient()}><OfflineStorage /></QueryClientProvider>);

describe('OfflineStorage', () => {
  it('says the notes are on this device when this tab holds them, with nothing to press', () => {
    draw();
    expect(screen.getByText(/Your notes are always on this device\. Their files/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open here' })).toBeNull();
  });

  it('says this tab works through the holder while it is a client, attached or attaching, and offers Open here', () => {
    vi.mocked(useLibraryElsewhere).mockReturnValue('u1');
    for (const presence of ['open', 'opening'] as const) {
      vi.mocked(useLibraryPresence).mockReturnValue(presence);
      draw();
      expect(screen.getByText(/Another tab or window has them open, and this one works through it/)).toBeTruthy();
      const button = screen.getByRole('button', { name: 'Open here' });
      expect(button.getAttribute('aria-description')).toMatch(/through this one/);
      fireEvent.click(button);
      cleanup();
    }
    expect(takeOverLibrary).toHaveBeenCalledTimes(2);
  });

  /**
   * What Unbent has stored is measured (`store/usage.ts`) and said in place of the
   * browser's estimate, which Chrome has put gigabytes over; the room the device allows
   * is still the browser's, since that is what it holds the site to.
   */
  it('says what Unbent has stored, measured, against the room the browser allows', async () => {
    const GB = 1024 ** 3;
    vi.mocked(useDeviceRoom).mockReturnValue({ room: { usage: 3.98 * GB, quota: 13.98 * GB, free: 9 * GB }, refresh: () => {} });
    vi.mocked(storedBytes).mockResolvedValue(57 * 1024 ** 2);
    draw();
    expect(await screen.findByText(/Unbent is using 57\.0 MB of the 13\.98 GB this device allows it\./)).toBeTruthy();
  });

  it('says the browser\'s estimate while nothing could be measured', () => {
    const GB = 1024 ** 3;
    vi.mocked(useDeviceRoom).mockReturnValue({ room: { usage: 2 * GB, quota: 10 * GB, free: 7 * GB }, refresh: () => {} });
    draw();
    expect(screen.getByText(/Unbent is using 2\.00 GB of the 10\.00 GB/)).toBeTruthy();
  });

  it('says this tab reads the server when it has no library to work through', () => {
    vi.mocked(useLibraryElsewhere).mockReturnValue('u1');
    vi.mocked(useLibraryPresence).mockReturnValue('none');
    draw();
    expect(screen.getByText(/cannot reach it, so it keeps nothing on the device and reads from the server/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open here' })).toBeTruthy();
  });
});
