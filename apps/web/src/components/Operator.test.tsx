import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BackupsStatus, DumpStatus, MirrorStatus, OperatorAccount } from '@unbent/shared';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params: _params, ...rest }: { children: React.ReactNode; to: string; params?: unknown; className?: string; 'aria-label'?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

/** The settings nav asks whether an import is running; none is. */
vi.mock('../import-run.js', () => ({ useImportRunning: () => false }));

const { AccountSearch, AccountsTable, BackupHealth, LastDump } = await import('./Operator.js');

const now = Date.parse('2026-10-06T12:00:00Z');

const dumps = (over: Partial<DumpStatus> = {}): DumpStatus => ({
  ranAt: '2026-10-06T09:47:00Z',
  run: { dumped: 3, bytes: 12_288, unchanged: 12, failed: 0, deferred: 0, done: true, subrequests: 20, ms: 1200 },
  accounts: 15,
  failing: [],
  failingCount: 0,
  stale: [],
  staleCount: 0,
  staleAfterHours: 48,
  ...over,
});

const mirror = (over: Partial<MirrorStatus> = {}): MirrorStatus => ({
  ranAt: '2026-10-06T05:23:00Z',
  finishedAt: '2026-10-06T05:31:00Z',
  ok: true,
  outcome: 'success',
  failedSteps: [],
  run: { event: 'schedule', id: '7', url: 'https://example.com/runs/7' },
  blobs: { copied: 4, bytes: 2048, errors: 0, errorLines: [], live: 4123, mirror: 4130 },
  stores: { copied: 8, bytes: 4096, errors: 0, errorLines: [] },
  d1: { key: 'd1/2026-10-06.sql', bytes: 609_280, written: true },
  prune: { gone: 7, pruned: 0, goneDays: 55 },
  dumps: { ok: true, reasons: [], ranAt: '2026-10-06T04:47:00Z', ageHours: 0.6 },
  ...over,
});

const account = (over: Partial<OperatorAccount> = {}): OperatorAccount => ({
  userId: 'u1',
  email: 'someone@example.com',
  name: null,
  createdAt: now - 30 * 86_400_000,
  noteCount: 12,
  storageBytes: 4096,
  lastActiveAt: now - 3_600_000,
  dump: { at: now - 2 * 3_600_000, bytes: 2048, checkedAt: now - 2 * 3_600_000, triedAt: now - 2 * 3_600_000, error: null },
  ...over,
});

/**
 * The health section's four states, as the words an operator reads and the sentence
 * for an instance that has no backups at all. The decisions behind the words are pinned
 * in `backup-health.test.ts`; this pins that the card says them, and says nothing
 * numeric where there is nothing to count.
 */
describe('BackupHealth', () => {
  afterEach(cleanup);

  it('names a failing account from the emails the route attaches, whatever the list has loaded', () => {
    const status: BackupsStatus = {
      bound: true,
      dumps: dumps({ failing: [{ userId: 'u9', error: 'boom', triedAt: '2026-10-06T09:47:00Z' }], failingCount: 1 }),
      mirror: mirror(),
      names: { u9: 'nine@example.com' },
    };
    render(<BackupHealth status={status} now={now} />);
    expect(screen.getByText(/nine@example.com/)).toBeTruthy();
    expect(screen.queryByText(/u9/)).toBeNull();
  });

  it('says backups are not set up, with no numbers, where no bucket is bound', () => {
    render(<BackupHealth status={{ bound: false }} now={now} />);
    expect(screen.getByText(/Backups are not set up on this instance/).textContent).toContain('“Where your notes live”');
    expect(document.querySelector('.health-card')).toBeNull();
  });

  it('says never run for each half until its file exists', () => {
    render(<BackupHealth status={{ bound: true, dumps: null, mirror: null, names: {} }} now={now} />);
    expect(screen.getByLabelText('Daily dumps: Never run')).toBeTruthy();
    expect(screen.getByLabelText('Nightly mirror: Never run')).toBeTruthy();
    expect(screen.getByText(/No dump run has written a status yet/)).toBeTruthy();
    expect(screen.getByText(/The mirror has not run yet/)).toBeTruthy();
  });

  it('reads healthy with when it ran and what it did', () => {
    const status: BackupsStatus = { bound: true, dumps: dumps(), mirror: mirror(), names: {} };
    render(<BackupHealth status={status} now={now} />);
    const card = screen.getByLabelText('Daily dumps: Healthy');
    expect(card.textContent).toContain('Ran 2 hours ago');
    expect(card.textContent).toContain('Dumped3 · 12 KB');
    expect(card.textContent).toContain('Unchanged12');
    expect(card.textContent).toContain('Accounts15');
    const m = screen.getByLabelText('Nightly mirror: Healthy');
    expect(m.textContent).toContain('Files4 copied · 4,123 live, 4,130 mirrored');
    expect(m.textContent).toContain('Dumps8 copied');
    expect(m.textContent).toContain('D1595 KB');
    expect(screen.getByRole('link', { name: 'The run on GitHub' }).getAttribute('href')).toBe('https://example.com/runs/7');
    expect(document.querySelector('.health-reasons')).toBeNull();
  });

  it('reads failed with the accounts and errors, and stale with the age', () => {
    const status: BackupsStatus = {
      bound: true,
      names: {},
      dumps: dumps({ failingCount: 1, failing: [{ userId: 'u9', error: 'the bucket refused the write', triedAt: '2026-10-06T09:47:00Z' }] }),
      mirror: mirror({ ranAt: '2026-10-02T05:23:00Z' }),
    };
    render(<BackupHealth status={status} now={now} />);
    const d = screen.getByLabelText('Daily dumps: Failed');
    expect(d.classList.contains('health-failed')).toBe(true);
    expect(d.textContent).toContain('1 account failed to dump.');
    expect(d.textContent).toContain('u9: the bucket refused the write');
    const m = screen.getByLabelText('Nightly mirror: Stale');
    expect(m.classList.contains('health-stale')).toBe(true);
    expect(m.textContent).toContain('The last run was 4 days ago, over 48 hours');
  });
});

describe('the Operator tab', () => {
  afterEach(cleanup);

  it('is drawn after About for an operator, and not at all for anyone else', async () => {
    const { SettingsLayout } = await import('./SettingsLayout.js');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { keys } = await import('../queries.js');
    for (const operator of [true, false]) {
      const client = new QueryClient();
      // The hook reads the backups query: an answer for an operator, the route's 404 kept as null for anyone else.
      client.setQueryData(keys.operatorBackups(), operator ? { bound: false } : null);
      render(
        <QueryClientProvider client={client}>
          <SettingsLayout>
            <p>page</p>
          </SettingsLayout>
        </QueryClientProvider>,
      );
      const labels = [...document.querySelectorAll('.settings-nav-item')].map((a) => a.textContent);
      if (operator) expect(labels.slice(-2)).toEqual(['About', 'Operator']);
      else expect(labels).not.toContain('Operator');
      cleanup();
    }
  });
});

describe('LastDump', () => {
  afterEach(cleanup);

  it('says when, that it failed and why, or never', () => {
    const { unmount } = render(<LastDump account={account()} now={now} />);
    expect(screen.getByText(/2 hours ago/).textContent).toBe('2 hours ago · 2 KB');
    unmount();
    render(<LastDump account={account({ dump: { at: null, bytes: null, checkedAt: null, triedAt: now - 60_000, error: 'needs more than the 50 subrequests' } })} now={now} />);
    expect(screen.getByText(/Failed/).textContent).toBe('Failed 1 minute ago');
    expect(screen.getByText('needs more than the 50 subrequests')).toBeTruthy();
    cleanup();
    render(<LastDump account={account({ dump: { at: null, bytes: null, checkedAt: null, triedAt: null, error: null } })} now={now} />);
    expect(screen.getByText('Never')).toBeTruthy();
  });
});

describe('AccountsTable', () => {
  afterEach(cleanup);

  it('opens each row from its email and its chevron, hides a name that is the email, and offers the next page', () => {
    const fetch = vi.fn();
    render(
      <AccountsTable
        accounts={[account({ userId: 'u1', email: 'one@example.com', name: 'one@example.com' }), account({ userId: 'u2', email: 'two@example.com', name: 'Two' })]}
        more={{ fetching: false, fetch }}
        now={now}
      />,
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('td')!.textContent).toBe('one@example.com');
    expect(rows[1]!.querySelector('td')!.textContent).toBe('two@example.com · Two');
    // The chevron is a second way to the same page: present, pointing there, and out of the tab order and the tree.
    const chevrons = document.querySelectorAll('a.operator-open-link');
    expect(chevrons).toHaveLength(2);
    expect(chevrons[0]!.getAttribute('href')).toBe('/settings/operator/$userId');
    expect(chevrons[0]!.getAttribute('tabindex')).toBe('-1');
    expect(screen.getAllByRole('link')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Show more accounts' }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText('2 shown')).toBeTruthy();
  });

  it('shows when an account with no recorded write was made', () => {
    render(<AccountsTable accounts={[account({ lastActiveAt: null, createdAt: now - 3_600_000 })]} more={null} now={now} />);
    const cell = screen.getByText(/^Made /);
    expect(cell.textContent).toBe('Made 1 hour ago');
    expect(cell.getAttribute('title')).toBeTruthy();
  });

  it('offers no next page when there is none', () => {
    render(<AccountsTable accounts={[account()]} more={null} now={now} />);
    expect(screen.queryByRole('button', { name: 'Show more accounts' })).toBeNull();
  });

  it('says a search found nothing, naming it, rather than that there are no accounts', () => {
    render(<AccountsTable accounts={[]} more={null} search="acme" now={now} />);
    expect(screen.getByText(/No account's email or name has “acme” in it/)).toBeTruthy();
    expect(screen.queryByText('No accounts yet.')).toBeNull();
  });

  it('marks the last search\'s accounts as busy while the next is answered', () => {
    render(<AccountsTable accounts={[account()]} more={null} stale now={now} />);
    expect(document.querySelector('.operator-table-wrap')!.getAttribute('aria-busy')).toBe('true');
  });
});

/**
 * The field hands its search on after a pause, trimmed, so a name typed at speed is one
 * request; follows a search changed under it (Back); and does not let its own search,
 * coming back, wipe letters typed since.
 */
describe('AccountSearch', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const field = () => screen.getByRole('searchbox', { name: 'Search accounts' }) as HTMLInputElement;

  it('hands the search on once typing pauses, trimmed', () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<AccountSearch search="" onSearch={onSearch} />);
    fireEvent.change(field(), { target: { value: 'ac' } });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.change(field(), { target: { value: ' acme ' } });
    act(() => vi.advanceTimersByTime(249));
    expect(onSearch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('acme');
  });

  it('clears on Escape at once', () => {
    const onSearch = vi.fn();
    render(<AccountSearch search="acme" onSearch={onSearch} />);
    expect(field().value).toBe('acme');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(field().value).toBe('');
    expect(onSearch).toHaveBeenCalledWith('');
  });

  it('follows a search changed under it, and keeps what was typed while its own came back', () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    const { rerender } = render(<AccountSearch search="" onSearch={onSearch} />);
    fireEvent.change(field(), { target: { value: 'acm' } });
    act(() => vi.advanceTimersByTime(250));
    fireEvent.change(field(), { target: { value: 'acme' } });
    // Its own search arrives in the address while the next letter waits.
    rerender(<AccountSearch search="acm" onSearch={onSearch} />);
    expect(field().value).toBe('acme');
    // Back to a different search replaces the draft.
    rerender(<AccountSearch search="pat" onSearch={onSearch} />);
    expect(field().value).toBe('pat');
  });
});
