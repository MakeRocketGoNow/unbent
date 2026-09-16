import type { ImportSkip } from '@unbent/enex';

/**
 * The skips an import run reports, kept for the panel to list.
 *
 * Split in two because the two kinds mean different things. A copy inside the file was
 * matched to a note this run created moments earlier, so a notebook that was empty before
 * the run can still report skips, and those are worth checking. A note that was here
 * before the run is a resumed or repeated import doing what it promises.
 */
export interface SkipLog {
  /** Matched to a note created earlier in the same file. */
  duplicates: ImportSkip[];
  duplicateCount: number;
  /** Matched to a note that was here before the run started. */
  present: ImportSkip[];
  presentCount: number;
}

/**
 * How many skips of each kind the panel holds on to.
 *
 * Counts stay exact past it, but the lists stop growing. Repeating a 13,000-note import
 * skips every note, and a list that long is no more useful than a count. The kinds are
 * capped separately so that thousands of expected skips can't crowd out the few
 * duplicates that are worth seeing.
 */
export const SKIP_LIST_LIMIT = 200;

export const emptySkipLog: SkipLog = {
  duplicates: [],
  duplicateCount: 0,
  present: [],
  presentCount: 0,
};

export function recordSkip(log: SkipLog, skip: ImportSkip): SkipLog {
  if (skip.earlierInFile) {
    return {
      ...log,
      duplicates:
        log.duplicates.length < SKIP_LIST_LIMIT ? [...log.duplicates, skip] : log.duplicates,
      duplicateCount: log.duplicateCount + 1,
    };
  }
  return {
    ...log,
    present: log.present.length < SKIP_LIST_LIMIT ? [...log.present, skip] : log.present,
    presentCount: log.presentCount + 1,
  };
}

export interface SkipGroup {
  noteId: string;
  title: string;
  /** How many skips were matched to this one note. */
  copies: number;
}

/**
 * One row per matched note, in the order each was first matched.
 *
 * A file with five empty "Untitled" notes keeps the first and skips four. Four identical
 * rows pointing at the same note look like a rendering bug, so they become one row with a
 * count.
 */
export function groupByMatch(skips: ImportSkip[]): SkipGroup[] {
  const groups = new Map<string, SkipGroup>();
  for (const skip of skips) {
    const group = groups.get(skip.noteId);
    if (group) group.copies += 1;
    else groups.set(skip.noteId, { noteId: skip.noteId, title: skip.title, copies: 1 });
  }
  return [...groups.values()];
}
