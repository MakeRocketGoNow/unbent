import type { ImportProgress } from '@unbent/enex';
import { describe, expect, it } from 'vitest';
import { importPercent } from './import-progress.js';

function progress(over: Partial<ImportProgress> = {}): ImportProgress {
  return {
    processed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    filesUploaded: 0,
    filesIndexed: 0,
    bytesRead: 0,
    notesTotal: 0,
    currentTitle: '',
    ...over,
  };
}

describe('importPercent', () => {
  it('counts notes when the total is known, whatever the bytes did', () => {
    // The archive case, and the bug: two of these notes carry the images that are almost
    // the whole file, but eleven notes of seventy-three is eleven of seventy-three.
    expect(importPercent(progress({ processed: 11, notesTotal: 73, bytesRead: 2_200_000 }), 2_276_000, false)).toBe(15);
  });

  it('does not race ahead when a few early notes hold most of the bytes', () => {
    // Two notes in, the byte bar was at 98%; the note bar is where the person is.
    expect(importPercent(progress({ processed: 2, notesTotal: 73 }), 2_276_000, false)).toBe(3);
  });

  it('reaches 100 when every note has been processed', () => {
    expect(importPercent(progress({ processed: 73, notesTotal: 73 }), 2_276_000, false)).toBe(100);
  });

  it('measures bytes off the file when the note total is unknown', () => {
    // The ENEX case: the parser cannot count notes without reading the file first.
    expect(importPercent(progress({ bytesRead: 250 }), 1000, false)).toBe(25);
  });

  it('is full once the run is over, whatever the last reading was', () => {
    // An ENEX reads its last bytes before the final uploads land; a bar a percent short
    // reads as stalled on a run that finished.
    expect(importPercent(progress({ bytesRead: 990 }), 1000, true)).toBe(100);
  });

  it('is empty before a run has anything to divide', () => {
    expect(importPercent(null, 1000, false)).toBe(0);
    expect(importPercent(progress(), 0, false)).toBe(0);
  });
});
