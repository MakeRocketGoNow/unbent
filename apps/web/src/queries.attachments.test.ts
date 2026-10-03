import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import * as api from './notes-api.js';
import { ApiError, OfflineError } from './notes-api.js';
import { attachmentsQuery } from './queries.js';
import { installTestLibrary } from './store/test-library.js';
import { setReachableForTests } from './connectivity.js';

vi.mock('./notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./notes-api.js')>()),
  listAttachments: vi.fn(),
}));

const file = { filename: 'scan.pdf', contentType: 'application/pdf', size: 12 };

describe('attachmentsQuery', () => {
  let lib: { uninstall: () => void } | null = null;
  afterEach(() => {
    lib?.uninstall();
    lib = null;
    vi.clearAllMocks();
  });

  it('asks the server for files of a note the copy does not hold yet', async () => {
    // A link followed during the first copy: the note body comes from the server, and
    // its files used to 404 because the collection had no row.
    lib = installTestLibrary({ cursor: null });
    vi.mocked(api.listAttachments).mockResolvedValue([file]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(client.fetchQuery(attachmentsQuery('n-missing'))).resolves.toEqual([file]);
    expect(api.listAttachments).toHaveBeenCalledWith('n-missing');
  });

  it('says the note is not on this device yet when offline during the first copy', async () => {
    lib = installTestLibrary({ cursor: null });
    setReachableForTests(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(client.fetchQuery(attachmentsQuery('n-missing'))).rejects.toBeInstanceOf(OfflineError);
    expect(api.listAttachments).not.toHaveBeenCalled();
  });

  it('treats a missing note as gone once a snapshot has been taken', async () => {
    lib = installTestLibrary({ cursor: { seq: 1, epoch: 'test' } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(client.fetchQuery(attachmentsQuery('n-missing'))).rejects.toMatchObject({ status: 404 });
    expect(api.listAttachments).not.toHaveBeenCalled();
  });
});
