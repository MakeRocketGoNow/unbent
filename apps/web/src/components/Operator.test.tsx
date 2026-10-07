import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { BackupsStatus, DumpStatus, MirrorStatus, OperatorAccount } from '@unbent/shared';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode; to: string; params?: unknown; className?: string }) => (
    <a href={rest.to} className={rest.className}>
      {children}
    </a>
  ),
}));

const { BackupHealth, LastDump } = await import('./Operator.js');

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

  it('says backups are not set up, with no numbers, where no bucket is bound', () => {
    render(<BackupHealth status={{ bound: false }} now={now} />);
    expect(screen.getByText(/Backups are not set up on this instance/)).toBeTruthy();
    expect(document.querySelector('.health-card')).toBeNull();
  });

  it('says never run for each half until its file exists', () => {
    render(<BackupHealth status={{ bound: true, dumps: null, mirror: null }} now={now} />);
    expect(screen.getByLabelText('Daily dumps: Never run')).toBeTruthy();
    expect(screen.getByLabelText('Nightly mirror: Never run')).toBeTruthy();
    expect(screen.getByText(/No dump run has written a status yet/)).toBeTruthy();
    expect(screen.getByText(/The mirror has not run yet/)).toBeTruthy();
  });

  it('reads healthy with when it ran and what it did', () => {
    const status: BackupsStatus = { bound: true, dumps: dumps(), mirror: mirror() };
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
