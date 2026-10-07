import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccountDumps, OperatorAccount as Account } from '@unbent/shared';
import type { StoreStats } from '../notes-api.js';
import { keys } from '../queries.js';
import { formatMoment } from './format-when.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  previewRestore: vi.fn(),
  restoreStore: vi.fn(),
  previewLoad: vi.fn(),
  loadDump: vi.fn(),
  resyncDevices: vi.fn(),
  accountDumps: vi.fn(),
  storeStats: vi.fn(),
}));

const api = await import('../notes-api.js');
const { OperatorAccount } = await import('./OperatorAccount.js');

const now = Date.parse('2026-10-06T12:00:00Z');

const account: Account = {
  userId: 'u1',
  email: 'someone@example.com',
  name: 'Someone',
  createdAt: now - 30 * 86_400_000,
  noteCount: 12,
  storageBytes: 4096,
  lastActiveAt: now - 3_600_000,
  dump: { at: now - 7_200_000, bytes: 2048, checkedAt: now - 7_200_000, triedAt: now - 7_200_000, error: null },
};

const stats = (counts: Partial<Record<string, number>> = {}): StoreStats => ({
  userId: 'u1',
  databaseSize: 1_048_576,
  migrations: ['0001-init', '0002-changes', '0003-revisions', '0004-revision-props', '0005-deleted-blobs'],
  counts: { notes: 12, notebooks: 2, tags: 3, attachments: 4, note_revisions: 40, ...counts },
  wiped: false,
  loading: null,
  lastWriteAt: now - 60_000,
});

const dumps: AccountDumps = {
  dumps: [
    { key: 'stores/u1/2026-10-06.sql', name: '2026-10-06.sql', size: 30_000, uploadedAt: '2026-10-06T04:47:00Z' },
    { key: 'stores/u1/2026-10-05.sql', name: '2026-10-05.sql', size: 29_000, uploadedAt: '2026-10-05T04:47:00Z' },
  ],
};

function harness(answerDumps: () => Promise<AccountDumps> = () => Promise.resolve(dumps), seeded: StoreStats | null = stats(), who: Account = account) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.operatorAccounts(), [who]);
  if (seeded) client.setQueryData(keys.storeStats('u1'), seeded);
  vi.mocked(api.accountDumps).mockImplementation(answerDumps);
  return render(
    <QueryClientProvider client={client}>
      <OperatorAccount userId="u1" />
    </QueryClientProvider>,
  );
}

const flush = () => act(async () => {});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OperatorAccount: facts', () => {
  it("shows the store's own last write once the stats are in, not the directory's sweep-time copy", async () => {
    harness();
    await flush();
    const dd = screen.getByText('Last change').nextElementSibling!;
    expect(dd.textContent).toContain(formatMoment(now - 60_000));
    expect(dd.textContent).not.toContain(formatMoment(account.lastActiveAt!));
    expect(dd.textContent).not.toContain('as of the last sweep');
  });

  it("shows the directory's value, said to be the sweep's, while the stats are on their way", () => {
    vi.mocked(api.storeStats).mockReturnValue(new Promise(() => {}));
    harness(undefined, null);
    const dd = screen.getByText('Last change').nextElementSibling!;
    expect(dd.textContent).toContain(formatMoment(account.lastActiveAt!));
    expect(dd.textContent).toContain('as of the last sweep');
  });

  it('says nothing is written yet when the store answers with no write, whatever the sweep last saw', async () => {
    harness(undefined, { ...stats(), lastWriteAt: null });
    await flush();
    expect(screen.getByText('Last change').nextElementSibling!.textContent).toBe('Nothing written yet');
  });

  it("shows the sweep's value, not 'Nothing written yet', for a store that cannot read its feed", async () => {
    const marker = { id: 'l1', key: 'stores/u1/2026-10-05.sql', startedAt: now, pages: 2, undo: null, before: null };
    for (const state of [{ wiped: true }, { loading: marker }]) {
      harness(undefined, { ...stats(), lastWriteAt: null, ...state });
      await flush();
      const dd = screen.getByText('Last change').nextElementSibling!;
      expect(dd.textContent).toContain(formatMoment(account.lastActiveAt!));
      expect(dd.textContent).toContain('as of the last sweep');
      expect(dd.textContent).not.toContain('Nothing written yet');
      cleanup();
    }
  });

  it('says nothing is recorded, not that it is still reading, once a stats read has failed', async () => {
    let fail!: (err: Error) => void;
    vi.mocked(api.storeStats).mockReturnValue(new Promise((_, reject) => (fail = reject)));
    harness(undefined, null, { ...account, lastActiveAt: null });
    const dd = () => screen.getByText('Last change').nextElementSibling!;
    expect(dd().textContent).toBe('Reading the store…');
    act(() => fail(new Error('store unavailable')));
    await waitFor(() => expect(dd().textContent).toBe('None recorded'));
  });
});

/**
 * The three actions, each as the confirm it opens: who, to what, and what is lost. The
 * routes are mocked with the shapes the deployed Worker answers, since the local one
 * keeps no history; what is pinned is that the page puts the dry run's numbers into the
 * question, repeats the request with the word, and offers the bookmark it gets back.
 */
describe('OperatorAccount: wind back', () => {
  it('previews first, then names the account, the moment and what is lost, then offers Undo', async () => {
    vi.mocked(api.previewRestore).mockResolvedValue({ dryRun: true, user: 'u1', bookmark: 'bm-1', current: stats({ notes: 12, attachments: 4, note_revisions: 40 }) });
    vi.mocked(api.restoreStore).mockResolvedValue({ restored: true, user: 'u1', undo: '00000001-00000002-00000003-0000000000000004', feedEpoch: 'e2', stats: stats({ notes: 9, attachments: 3, note_revisions: 20 }), note: '' });
    harness();
    const moment = screen.getByLabelText('Moment') as HTMLInputElement;
    fireEvent.change(moment, { target: { value: '2026-10-05T10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await flush();
    // Nothing is wound back by a preview: the dry run is the call, without the word.
    expect(api.previewRestore).toHaveBeenCalledWith('u1', { at: Date.parse('2026-10-05T10:30') });
    expect(api.restoreStore).not.toHaveBeenCalled();

    const confirm = screen.getByRole('group', { name: 'Confirm wind back' });
    expect(confirm.textContent).toContain('Wind back someone@example.com to');
    expect(confirm.textContent).toContain('Every note, file record and revision written after that moment is lost.');
    expect(confirm.textContent).toContain('The store now holds 12 notes, 4 files and 40 revisions');
    expect(confirm.textContent).toContain('Every device of the account resyncs from a snapshot.');
    expect(confirm.classList.contains('confirm-danger')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Wind back' }));
    await flush();
    expect(api.restoreStore).toHaveBeenCalledWith('u1', { at: Date.parse('2026-10-05T10:30') });
    expect(screen.getByText(/Wound back to/).textContent).toContain('The store now holds 9 notes, 3 files and 20 revisions.');

    // Undo is a second confirm against the bookmark the answer carried.
    fireEvent.click(screen.getByRole('button', { name: 'Undo the wind-back' }));
    const undo = screen.getByRole('group', { name: 'Confirm undo wind back' });
    expect(undo.textContent).toContain('Put someone@example.com back as it was before the wind-back?');
    expect(undo.textContent).toContain('Anything written since the wind-back is lost');
    vi.mocked(api.restoreStore).mockResolvedValue({ restored: true, user: 'u1', undo: null, feedEpoch: 'e3', stats: stats(), note: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo the wind-back' }));
    await flush();
    expect(api.restoreStore).toHaveBeenLastCalledWith('u1', { bookmark: '00000001-00000002-00000003-0000000000000004' });
    expect(screen.getByText(/Put back as it was before the wind-back/)).toBeTruthy();
  });

  it('keeps the undo bookmark through a change of moment or a second preview', async () => {
    vi.mocked(api.previewRestore).mockResolvedValue({ dryRun: true, user: 'u1', bookmark: 'bm-1', current: stats() });
    vi.mocked(api.restoreStore).mockResolvedValue({ restored: true, user: 'u1', undo: '00000001-00000002-00000003-0000000000000004', feedEpoch: 'e2', stats: stats(), note: '' });
    harness();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Wind back' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Undo the wind-back' })).toBeTruthy();
    // A stray touch of the field, then another preview: the way back stays on screen.
    fireEvent.change(screen.getByLabelText('Moment'), { target: { value: '2026-10-04T08:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await flush();
    expect(screen.getByRole('group', { name: 'Confirm wind back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo the wind-back' })).toBeTruthy();
  });

  it('closes the confirm when the wind-back fails, so a second press cannot restore twice', async () => {
    vi.mocked(api.previewRestore).mockResolvedValue({ dryRun: true, user: 'u1', bookmark: 'bm-1', current: stats() });
    vi.mocked(api.restoreStore).mockRejectedValue(new api.ApiError(502, 'The restore may have been applied.'));
    harness();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Wind back' }));
    await flush();
    expect(screen.getByText('The restore may have been applied.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Confirm wind back' })).toBeNull();
  });

  it('says restores work on a deployed instance only where the runtime keeps no history', async () => {
    vi.mocked(api.previewRestore).mockRejectedValue(new api.ApiError(501, 'This runtime keeps no history to restore from. Restores work on a deployed instance only.'));
    harness();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await flush();
    expect(screen.getByText(/Restores work on a deployed instance only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Confirm wind back' })).toBeNull();
  });
});

describe('OperatorAccount: load a dump', () => {
  it('lists the dumps with a download link each, and the command for an older one', async () => {
    harness();
    await waitFor(() => expect(screen.getByText('2026-10-06.sql')).toBeTruthy());
    const links = screen.getAllByRole('link', { name: 'Download' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/api/admin/accounts/u1/dumps/2026-10-06.sql', '/api/admin/accounts/u1/dumps/2026-10-05.sql']);
    expect(links[0]!.hasAttribute('download')).toBe(true);
    expect(screen.getByText(/For a dump older than 14 days/)).toBeTruthy();
    expect(screen.getByText('rclone copy mirror:unbent-mirror/stores/u1/ dumps:unbent-backups/stores/u1/')).toBeTruthy();
    // The store as it stands is a link too, to the dump route.
    expect(screen.getByRole('link', { name: 'Download the store as it is now' }).getAttribute('href')).toBe('/api/admin/store/dump?user=u1');
  });

  it('reads the dump first, then names the account, the dump, when it was taken and what is replaced', async () => {
    vi.mocked(api.previewLoad).mockResolvedValue({
      dryRun: true,
      user: 'u1',
      dump: { key: 'stores/u1/2026-10-05.sql', size: 29_000, uploadedAt: '2026-10-05T04:47:00Z', owner: 'u1', header: '-- Unbent note store of account u1, dumped 2026-10-05T04:47:03.000Z', oneMoment: false },
      current: stats(),
    });
    vi.mocked(api.loadDump).mockResolvedValue({
      loaded: true,
      user: 'u1',
      key: 'stores/u1/2026-10-05.sql',
      before: 'stores/u1/2026-10-06T12-00-00Z-before-load.sql',
      undo: '00000001-00000002-00000003-0000000000000004',
      feedEpoch: 'e2',
      migrated: [],
      foreignKeyViolations: 0,
      stats: stats({ notes: 11 }),
      note: '',
    });
    harness();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Load' }).length).toBe(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Load' })[1]!);
    await flush();
    expect(api.previewLoad).toHaveBeenCalledWith('u1', 'stores/u1/2026-10-05.sql');
    expect(api.loadDump).not.toHaveBeenCalled();

    const confirm = screen.getByRole('group', { name: 'Confirm load dump' });
    expect(confirm.textContent).toContain("Replace someone@example.com's store with the dump 2026-10-05.sql?");
    expect(confirm.textContent).toContain(`Taken ${new Date('2026-10-05T04:47:03.000Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`);
    expect(confirm.textContent).toContain('The store was written to while this dump was read');
    expect(confirm.textContent).toContain('The store now holds 12 notes, 4 files and 40 revisions, and every one of them is replaced');
    expect(confirm.textContent).toContain('A dump of the store as it stands is written first');
    expect(confirm.classList.contains('confirm-danger')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Load dump' }));
    await flush();
    expect(api.loadDump).toHaveBeenCalledWith('u1', 'stores/u1/2026-10-05.sql');
    const result = screen.getByText(/Loaded 2026-10-05.sql/);
    expect(result.textContent).toContain('The store now holds 11 notes, 4 files and 40 revisions');
    expect(result.textContent).toContain('The store as it stood is 2026-10-06T12-00-00Z-before-load.sql, in the list above.');

    fireEvent.click(screen.getByRole('button', { name: 'Undo the load' }));
    const undo = screen.getByRole('group', { name: 'Confirm undo load' });
    expect(undo.textContent).toContain("Put someone@example.com's store back as it was before the load?");
    vi.mocked(api.restoreStore).mockResolvedValue({ restored: true, user: 'u1', undo: null, feedEpoch: 'e3', stats: stats(), note: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo the load' }));
    await flush();
    expect(api.restoreStore).toHaveBeenCalledWith('u1', { bookmark: '00000001-00000002-00000003-0000000000000004' });
  });

  it('says where to undo when the runtime handed back no bookmark', async () => {
    vi.mocked(api.previewLoad).mockResolvedValue({
      dryRun: true,
      user: 'u1',
      dump: { key: 'stores/u1/2026-10-06.sql', size: 30_000, uploadedAt: '2026-10-06T04:47:00Z', owner: 'u1', header: '-- Unbent note store of account u1, dumped 2026-10-06T04:47:03.000Z', oneMoment: true },
      current: stats(),
    });
    vi.mocked(api.loadDump).mockResolvedValue({
      loaded: true,
      user: 'u1',
      key: 'stores/u1/2026-10-06.sql',
      before: 'stores/u1/2026-10-06T12-00-00Z-before-load.sql',
      undo: null,
      feedEpoch: 'e2',
      migrated: ['0005-deleted-blobs'],
      foreignKeyViolations: 0,
      stats: stats(),
      note: '',
    });
    harness();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Load' }).length).toBe(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Load' })[0]!);
    await flush();
    expect(screen.getByRole('group', { name: 'Confirm load dump' }).textContent).not.toContain('written to while');
    fireEvent.click(screen.getByRole('button', { name: 'Load dump' }));
    await flush();
    expect(screen.queryByRole('button', { name: 'Undo the load' })).toBeNull();
    expect(screen.getByText(/This runtime keeps no bookmarks; to undo, load 2026-10-06T12-00-00Z-before-load.sql/)).toBeTruthy();
    expect(screen.getByText(/Schema files the dump lacked were applied: 0005-deleted-blobs/)).toBeTruthy();
  });

  it('keeps the way back when a load fails after emptying the store', async () => {
    vi.mocked(api.previewLoad).mockResolvedValue({
      dryRun: true,
      user: 'u1',
      dump: { key: 'stores/u1/2026-10-06.sql', size: 30_000, uploadedAt: '2026-10-06T04:47:00Z', owner: 'u1', header: '-- Unbent note store of account u1, dumped 2026-10-06T04:47:03.000Z', oneMoment: true },
      current: stats(),
    });
    vi.mocked(api.loadDump).mockRejectedValue(
      new api.LoadFailedError('The load failed: statement 12 refused.', '00000001-00000002-00000003-0000000000000004', 'stores/u1/2026-10-06T12-00-00Z-before-load.sql'),
    );
    harness();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Load' }).length).toBe(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Load' })[0]!);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Load dump' }));
    await flush();
    const failed = screen.getByText(/Loading 2026-10-06.sql stopped partway/);
    // The route's message already begins "The load failed:", said once here, and ends with a full stop whether or not the runtime's did.
    expect(failed.textContent).toContain('stopped partway: statement 12 refused. The store is');
    expect(failed.textContent).toContain('2026-10-06T12-00-00Z-before-load.sql, is in the list above');
    // The confirm is gone — its counts are of a store that no longer exists — and the
    // bookmark is one press away rather than a line in the Worker log.
    expect(screen.queryByRole('group', { name: 'Confirm load dump' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo the load' }));
    vi.mocked(api.restoreStore).mockResolvedValue({ restored: true, user: 'u1', undo: null, feedEpoch: 'e3', stats: stats(), note: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo the load' }));
    await flush();
    expect(api.restoreStore).toHaveBeenCalledWith('u1', { bookmark: '00000001-00000002-00000003-0000000000000004' });
  });

  it('says so where no bucket is bound, without the list or the command', async () => {
    harness(() => Promise.reject(new api.ApiError(501, 'This instance has no backups bucket bound, so there are no dumps to list.')));
    await waitFor(() => expect(screen.getByText(/no backups bucket bound/)).toBeTruthy());
    expect(screen.queryByText(/For a dump older than/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load' })).toBeNull();
  });
});

describe('OperatorAccount: resync devices', () => {
  it('asks with a plain confirm that says nothing is deleted, then says every device will copy again', async () => {
    vi.mocked(api.resyncDevices).mockResolvedValue({ user: 'u1', epoch: 'abcdef0123456789' });
    harness();
    fireEvent.click(screen.getByRole('button', { name: 'Resync devices' }));
    const confirm = screen.getByRole('group', { name: 'Confirm resync devices' });
    expect(confirm.textContent).toContain('Resync every device of someone@example.com?');
    expect(confirm.textContent).toContain('Nothing is deleted and nothing is written');
    // Not destructive, so not red: the border is the neutral one.
    expect(confirm.classList.contains('confirm-neutral')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
    await flush();
    expect(api.resyncDevices).toHaveBeenCalledWith('u1');
    expect(screen.getByText(/Done. Every device of the account will copy the library again/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Confirm resync devices' })).toBeNull();
  });
});

describe('OperatorAccount: the store', () => {
  it('shows the live counts and the schema, and says when the store is loading', () => {
    harness();
    expect(screen.getByText('someone@example.com')).toBeTruthy();
    const facts = document.querySelector('.store-facts')!;
    expect(facts.textContent).toContain('Notes12');
    expect(facts.textContent).toContain('Files4');
    expect(facts.textContent).toContain('Revisions40');
    expect(facts.textContent).toContain('Schema0005-deleted-blobs');
    expect(facts.textContent).toContain('Size1.0 MB');
    cleanup();

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.operatorAccounts(), [account]);
    client.setQueryData(keys.storeStats('u1'), {
      ...stats(),
      loading: { id: 'l1', key: 'stores/u1/2026-10-05.sql', startedAt: now, pages: 2, undo: '00000001-00000002-00000003-0000000000000004', before: 'stores/u1/2026-10-06T12-00-00Z-before-load.sql' },
    });
    vi.mocked(api.accountDumps).mockResolvedValue(dumps);
    render(
      <QueryClientProvider client={client}>
        <OperatorAccount userId="u1" />
      </QueryClientProvider>,
    );
    const notice = screen.getByText(/Loading stores\/u1\/2026-10-05.sql since/);
    expect(notice.textContent).toContain('refusing every request until it is whole');
    // The ways back come from the store's own marker, so a reload or a second operator still has them.
    expect(notice.textContent).toContain('2026-10-06T12-00-00Z-before-load.sql, is in the list below');
    expect(screen.getByRole('button', { name: 'Undo the load' })).toBeTruthy();
  });
});
