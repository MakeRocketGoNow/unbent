import { describe, expect, it } from 'vitest';
import type { DumpStatus, MirrorStatus } from '@unbent/shared';
import { dumpsHealth, mirrorHealth } from './backup-health.js';

const now = Date.parse('2026-10-06T12:00:00Z');

const dumps = (over: Partial<DumpStatus> = {}): DumpStatus => ({
  ranAt: '2026-10-06T09:47:00Z',
  run: { dumped: 2, bytes: 4096, unchanged: 3, failed: 0, deferred: 0, done: true, subrequests: 12, ms: 900 },
  accounts: 5,
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
  run: { event: 'schedule', id: '1', url: 'https://example.com/run/1' },
  blobs: { copied: 4, bytes: 1024, errors: 0, errorLines: [], live: 4123, mirror: 4130 },
  stores: { copied: 2, bytes: 4096, errors: 0, errorLines: [] },
  d1: { key: 'd1/2026-10-06.sql', bytes: 609_000, written: true },
  prune: { gone: 7, pruned: 0, goneDays: 55 },
  dumps: { ok: true, reasons: [], ranAt: '2026-10-06T04:47:00Z', ageHours: 0.6 },
  ...over,
});

/**
 * The four words the health card can lead with, and what decides each. Pinned as a pure
 * function because the words are the whole point of the card: an operator glancing at
 * it has to be told "failed" when something failed and nothing softer.
 */
describe('dumps health', () => {
  it('is never run without a file, and healthy with a recent clean one', () => {
    expect(dumpsHealth(null, now)).toEqual({ state: 'never', reasons: [] });
    expect(dumpsHealth(dumps(), now)).toEqual({ state: 'healthy', reasons: [] });
  });

  it('is failed when accounts failed, naming them and their errors', () => {
    const h = dumpsHealth(dumps({ failingCount: 1, failing: [{ userId: 'u1', error: 'bucket refused the write', triedAt: null }] }), now);
    expect(h.state).toBe('failed');
    expect(h.reasons).toEqual(['1 account failed to dump.', 'u1: bucket refused the write']);
  });

  it('is stale when the last run is older than the window the file states', () => {
    const h = dumpsHealth(dumps({ ranAt: '2026-10-03T09:47:00Z' }), now);
    expect(h.state).toBe('stale');
    expect(h.reasons[0]).toBe('The last run was 3 days ago, over 48 hours; the cron has stopped or the bucket binding has gone.');
  });

  it('is stale when an account has not been found current, even after a recent run', () => {
    const h = dumpsHealth(dumps({ staleCount: 2, stale: ['u1', 'u2'] }), now);
    expect(h.state).toBe('stale');
    expect(h.reasons).toEqual(['2 accounts have no dump found current in 48 hours: u1, u2.']);
  });

  it('calls a failed run failed, not stale, however old it is', () => {
    const h = dumpsHealth(dumps({ ranAt: '2026-09-01T00:00:00Z', failingCount: 1, failing: [{ userId: 'u1', error: 'x', triedAt: null }] }), now);
    expect(h.state).toBe('failed');
  });
});

describe('mirror health', () => {
  it('is never run without a file, and healthy with a recent ok one', () => {
    expect(mirrorHealth(null, now)).toEqual({ state: 'never', reasons: [] });
    expect(mirrorHealth(mirror(), now)).toEqual({ state: 'healthy', reasons: [] });
  });

  it('is failed when the run was not ok, with the steps, the copy errors and the dump check', () => {
    const h = mirrorHealth(
      mirror({
        ok: false,
        outcome: 'failure',
        failedSteps: ['blobs', 'dumps-check'],
        blobs: { copied: 3, bytes: 10, errors: 1, errorLines: ['users/u1/f1: access denied'], live: 4, mirror: 4 },
        dumps: { ok: false, reasons: ['1 account(s) failed to dump: u1: x'], ranAt: null, ageHours: null },
      }),
      now,
    );
    expect(h.state).toBe('failed');
    expect(h.reasons).toEqual(['Failed at: blobs, dumps-check.', 'users/u1/f1: access denied', '1 account(s) failed to dump: u1: x']);
  });

  it('says a cancelled run was cancelled rather than that it failed at a step', () => {
    const h = mirrorHealth(mirror({ ok: false, outcome: 'cancelled' }), now);
    expect(h.reasons[0]).toBe('The run was cancelled before it finished.');
  });

  it('is stale after two nights without a run', () => {
    const h = mirrorHealth(mirror({ ranAt: '2026-10-03T05:23:00Z' }), now);
    expect(h.state).toBe('stale');
    expect(h.reasons[0]).toBe('The last run was 3 days ago, over 48 hours; the workflow has not run since.');
  });
});
