import { describe, expect, it } from 'vitest';
import type { ImportSkip } from '@unbent/enex';
import { SKIP_LIST_LIMIT, emptySkipLog, groupByMatch, recordSkip } from './import-skips.js';

const skip = (over: Partial<ImportSkip> = {}): ImportSkip => ({
  title: 'Parking receipt',
  noteId: 'n-1',
  earlierInFile: true,
  ...over,
});

describe('recordSkip', () => {
  it('keeps copies inside the file apart from notes that were already here', () => {
    let log = emptySkipLog;
    log = recordSkip(log, skip());
    log = recordSkip(log, skip({ title: 'Coupon', noteId: 'n-2', earlierInFile: false }));

    expect(log.duplicates.map((s) => s.title)).toEqual(['Parking receipt']);
    expect(log.present.map((s) => s.title)).toEqual(['Coupon']);
    expect(log.duplicateCount).toBe(1);
    expect(log.presentCount).toBe(1);
  });

  it('stops listing past the limit but keeps counting', () => {
    let log = emptySkipLog;
    for (let i = 0; i < SKIP_LIST_LIMIT + 5; i += 1) {
      log = recordSkip(log, skip({ noteId: `n-${i}`, earlierInFile: false }));
    }

    expect(log.present).toHaveLength(SKIP_LIST_LIMIT);
    expect(log.presentCount).toBe(SKIP_LIST_LIMIT + 5);
  });

  it('still lists duplicates after thousands of expected skips', () => {
    let log = emptySkipLog;
    for (let i = 0; i < SKIP_LIST_LIMIT * 3; i += 1) {
      log = recordSkip(log, skip({ noteId: `n-${i}`, earlierInFile: false }));
    }
    log = recordSkip(log, skip({ title: 'Untitled', noteId: 'dup' }));

    expect(log.duplicates.map((s) => s.noteId)).toEqual(['dup']);
  });
});

describe('groupByMatch', () => {
  it('folds copies of one note into a row with a count, in first-seen order', () => {
    const groups = groupByMatch([
      skip({ title: 'Untitled', noteId: 'a' }),
      skip({ title: 'Parking receipt', noteId: 'b' }),
      skip({ title: 'Untitled', noteId: 'a' }),
      skip({ title: 'Untitled', noteId: 'a' }),
    ]);

    expect(groups).toEqual([
      { noteId: 'a', title: 'Untitled', copies: 3 },
      { noteId: 'b', title: 'Parking receipt', copies: 1 },
    ]);
  });
});
