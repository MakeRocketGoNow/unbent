import { describe, expect, it } from 'vitest';
import { BOOKMARK_PATTERN, isRestoreUnsupported, readRestoreAbort, restoreAbortReason } from './restore.js';

const BOOKMARK = '0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b';
const UNDO = '0000007b-0000b26f-00001539-1d4f98cc48c4ec6dd63ffec04de4ca7c';

/**
 * The restore's one call ends in the object aborting, so the undo bookmark comes back in
 * the error rather than a result. These pin that it survives the trip, including when the
 * runtime wraps the reason, and that an error that is not the abort is never read as one.
 */
describe('restore abort reason', () => {
  it('carries the undo bookmark, bare or wrapped', () => {
    const reason = restoreAbortReason(BOOKMARK, UNDO);
    expect(readRestoreAbort(new Error(reason))).toEqual({ scheduled: true, undo: UNDO });
    expect(readRestoreAbort(new Error(`Durable Object reset: ${reason}.`))).toEqual({ scheduled: true, undo: UNDO });
    expect(readRestoreAbort(reason)).toEqual({ scheduled: true, undo: UNDO });
  });

  it('reads any other error as a restore that did not happen', () => {
    expect(readRestoreAbort(new Error('Cannot restore to a time more than 30 days ago'))).toEqual({ scheduled: false, undo: null });
    expect(readRestoreAbort(new Error(`undo=${UNDO}`))).toEqual({ scheduled: false, undo: null });
  });

  it('knows the runtime that keeps no history', () => {
    expect(isRestoreUnsupported(new Error("This Durable Object's storage back-end does not implement point-in-time recovery."))).toBe(true);
    expect(isRestoreUnsupported(new Error('something else'))).toBe(false);
  });
});

describe('BOOKMARK_PATTERN', () => {
  it('takes the runtime\'s shape and refuses anything that could be a typo or a time', () => {
    expect(BOOKMARK_PATTERN.test(BOOKMARK)).toBe(true);
    expect(BOOKMARK_PATTERN.test(BOOKMARK.toUpperCase())).toBe(true);
    expect(BOOKMARK_PATTERN.test(BOOKMARK.slice(0, -20))).toBe(false);
    expect(BOOKMARK_PATTERN.test('2026-09-30T12:00:00Z')).toBe(false);
    expect(BOOKMARK_PATTERN.test(`${BOOKMARK} `)).toBe(false);
  });
});
